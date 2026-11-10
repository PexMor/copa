import { createApi, CopaAuthError, createAuthProvider, type AuthContext, type AuthProvider } from './auth';
import type { EndpointConfig } from './config';
import { classifyBlob } from './content';
import { formatSize, uploadFile, type Capabilities, type CopaApi, type FileDownload, type HistoryItem } from './core';

export type ShareErrorCode = 'too-large' | 'forbidden' | 'unsupported' | 'empty';

/** What the host may hand to `share()`. */
export type ShareData = string | Blob | File;

export interface ShareOptions {
  /** File name for a Blob/oversized text that has none. */
  name?: string;
  /** A file transfer is about to start. */
  onStart?: (info: { name: string; total: number }) => void;
  onProgress?: (loaded: number) => void;
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt', 'text/html': 'html', 'application/zip': 'zip',
};

/** An operation the widget refuses before sending anything. */
export class ShareError extends Error {
  constructor(public code: ShareErrorCode, message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * Headless connection to one endpoint: owns the auth provider, the API client
 * and the server capabilities. The UI and the host API both go through it.
 */
export class CopaSession {
  readonly provider: AuthProvider;
  readonly api: CopaApi;
  caps: Capabilities | null = null;
  capsLoaded = false;

  constructor(readonly endpoint: EndpointConfig, ctx: AuthContext = {}, provider?: AuthProvider) {
    this.provider = provider ?? createAuthProvider(endpoint, ctx);
    this.api = createApi(endpoint, this.provider);
  }

  get ready(): boolean { return this.provider.state() === 'ready'; }

  /** Throws a typed error instead of silently queueing work while signed out. */
  requireReady(): void {
    if (!this.ready) throw new CopaAuthError('not-authenticated', 'Not signed in to ' + this.endpoint.id);
  }

  async loadCapabilities(): Promise<Capabilities | null> {
    this.requireReady();
    this.caps = await this.api.capabilitiesStrict();
    this.capsLoaded = true;
    return this.caps;
  }

  // An old server without /api/capabilities behaves as read+write, text only.
  get canRead(): boolean { return this.caps?.read ?? true; }
  get canWrite(): boolean { return this.caps?.write ?? true; }
  get filesEnabled(): boolean { return this.caps?.files === true; }
  get historyEnabled(): boolean { return this.caps?.history === true; }
  get sizeLimit(): number | undefined { return this.caps?.size_limit; }
  get maxFileSize(): number | undefined { return this.caps?.max_file_size; }

  /** Push text to the namespace clipboard, enforcing the namespace `size_limit` locally. */
  async pushText(text: string): Promise<void> {
    this.requireReady();
    if (!this.canWrite) throw new ShareError('forbidden', 'This credential cannot write to the namespace');
    const limit = this.sizeLimit;
    if (limit !== undefined && utf8Length(text) > limit) {
      throw new ShareError('too-large', `Text is ${formatSize(utf8Length(text))}; the limit is ${formatSize(limit)}`);
    }
    await this.api.postClipboard(text);
  }

  async pull(): Promise<string> {
    this.requireReady();
    if (!this.canRead) throw new ShareError('forbidden', 'This credential cannot read the namespace');
    return this.api.getClipboard();
  }

  /** Whole file flow; returns the stored item. */
  async upload(file: File | (Blob & { name?: string }), onProgress: (loaded: number) => void = () => {}): Promise<HistoryItem> {
    this.requireReady();
    if (!this.canWrite) throw new ShareError('forbidden', 'This credential cannot write to the namespace');
    if (!this.filesEnabled) throw new ShareError('unsupported', 'File sharing is not enabled for this namespace');
    return uploadFile(this.api, file as File, this.caps ?? {}, onProgress);
  }

  async history(): Promise<HistoryItem[]> {
    this.requireReady();
    if (!this.historyEnabled) return [];
    return this.api.history();
  }

  async itemText(id: string): Promise<string> {
    this.requireReady();
    return this.api.itemText(id);
  }

  async remove(id: string): Promise<void> {
    this.requireReady();
    if (!this.canWrite) throw new ShareError('forbidden', 'This credential cannot write to the namespace');
    await this.api.deleteItem(id);
  }

  /** Fresh short-lived presigned URL — use immediately, never store. */
  async fileDownload(id: string): Promise<FileDownload> {
    this.requireReady();
    return this.api.fileDownload(id);
  }

  /**
   * Share data with the namespace, routing by type and size:
   * text within `size_limit` → clipboard endpoint; files, Blobs and text above
   * the limit → presigned object-storage flow. Returns the stored item.
   */
  async share(data: ShareData, opts: ShareOptions = {}): Promise<HistoryItem> {
    this.requireReady();
    if (!this.canWrite) throw new ShareError('forbidden', 'This credential cannot write to the namespace');

    if (typeof data === 'string') {
      if (data === '') throw new ShareError('empty', 'Nothing to share');
      const size = utf8Length(data);
      const limit = this.sizeLimit;
      if (limit === undefined || size <= limit) {
        await this.api.postClipboard(data);
        return this.storedTextItem(data, size);
      }
      if (!this.filesEnabled) {
        throw new ShareError('too-large', `Text is ${formatSize(size)}; the limit is ${formatSize(limit)} and file sharing is not enabled`);
      }
      return this.shareFile(new File([data], opts.name ?? 'clipboard.txt', { type: 'text/plain' }), opts);
    }
    return this.shareFile(data, opts);
  }

  private async shareFile(data: Blob & { name?: string }, opts: ShareOptions): Promise<HistoryItem> {
    if (!this.filesEnabled) throw new ShareError('unsupported', 'File sharing is not enabled for this namespace');
    const c = await classifyBlob(data);
    const isNamed = typeof data.name === 'string' && data.name !== '';
    const generic = data.type === '' || data.type === 'application/octet-stream';
    const type = generic ? c.mime : data.type;
    const name = isNamed ? data.name! : opts.name ?? `clipboard.${EXT[type] ?? 'bin'}`;
    const file = data instanceof File && isNamed && data.type === type ? data : new File([data], name, { type });
    opts.onStart?.({ name, total: file.size });
    return this.upload(file, opts.onProgress);
  }

  /** The item the server just stored for pushed text (newest text item), or a local stand-in. */
  private async storedTextItem(text: string, size: number): Promise<HistoryItem> {
    if (this.historyEnabled) {
      try {
        const newest = (await this.api.history()).find((i) => i.kind === 'text');
        if (newest) return newest;
      } catch { /* fall back to the stand-in */ }
    }
    const now = Date.now();
    const ttl = (this.caps?.item_ttl_secs ?? 86400) * 1000;
    return { id: '', kind: 'text', created_at: now, expires_at: now + ttl, size, preview: text.slice(0, 200) };
  }
}
