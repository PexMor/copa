import type { Capabilities, FileDownload, HistoryItem, UploadGrant } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface CopaApiOptions {
  /** Server base URL without trailing slash. */
  baseUrl: string;
  namespace: string;
  /**
   * Full `Authorization` header value (for example `Bearer abc`). The auth
   * provider behind it may renew credentials; it is called for every request.
   */
  getHeader: () => string | Promise<string>;
  /**
   * Called after a 401. Resolve `true` when credentials were renewed; the
   * request is then retried exactly once.
   */
  onUnauthorized?: () => Promise<boolean>;
  /** A network error or an HTML (login page) response was seen. */
  onFailure?: (kind: 'network' | 'html') => void;
}

/** Minimal copa HTTP client. All auth is injected through `getHeader`. */
export class CopaApi {
  constructor(private readonly opts: CopaApiOptions) {}

  get baseUrl(): string { return this.opts.baseUrl; }
  get namespace(): string { return this.opts.namespace; }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.attempt(path, init);
    if (res.status === 401 && this.opts.onUnauthorized) {
      let renewed = false;
      try { renewed = await this.opts.onUnauthorized(); } catch { /* treated as not renewed */ }
      if (renewed) return this.finish(await this.attempt(path, init));
    }
    return this.finish(res);
  }

  private async attempt(path: string, init: RequestInit): Promise<Response> {
    const auth = await this.opts.getHeader();
    try {
      return await fetch(`${this.opts.baseUrl}${path}`, {
        ...init,
        headers: {
          'Authorization': auth,
          'X-Copa-Namespace': this.opts.namespace,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (e) {
      // a proxy redirect to the IdP surfaces as a network error
      this.opts.onFailure?.('network');
      throw e;
    }
  }

  private async finish(res: Response): Promise<Response> {
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      this.opts.onFailure?.('html'); // login page instead of API data
      throw new ApiError(res.status, 'Unexpected HTML response');
    }
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) message = body.error;
      } catch { /* not JSON */ }
      throw new ApiError(res.status, message);
    }
    return res;
  }

  /** null when the server predates history/files (no capability endpoint). */
  async capabilities(): Promise<Capabilities | null> {
    try {
      return await (await this.request('/api/capabilities')).json() as Capabilities;
    } catch {
      return null;
    }
  }

  /**
   * Like {@link capabilities} but only a 404 (server predates the endpoint)
   * means "no capabilities"; authentication and network errors are thrown.
   */
  async capabilitiesStrict(): Promise<Capabilities | null> {
    try {
      return await (await this.request('/api/capabilities')).json() as Capabilities;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  async history(): Promise<HistoryItem[]> {
    return await (await this.request('/api/history')).json() as HistoryItem[];
  }

  async itemText(id: string): Promise<string> {
    return (await this.request(`/api/history/${encodeURIComponent(id)}`)).text();
  }

  async deleteItem(id: string): Promise<void> {
    await this.request(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getClipboard(): Promise<string> {
    return (await this.request('/api/clipboard')).text();
  }

  async postClipboard(text: string): Promise<void> {
    await this.request('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    });
  }

  async requestUpload(file: { name: string; size: number; type?: string }): Promise<UploadGrant> {
    const res = await this.request('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, content_type: file.type || undefined }),
    });
    return await res.json() as UploadGrant;
  }

  async completeUpload(id: string): Promise<HistoryItem> {
    const res = await this.request(`/api/files/${encodeURIComponent(id)}/complete`, { method: 'POST' });
    return await res.json() as HistoryItem;
  }

  /** A fresh short-lived presigned download URL; must not be stored. */
  async fileDownload(id: string): Promise<FileDownload> {
    const res = await this.request(`/api/files/${encodeURIComponent(id)}`);
    return await res.json() as FileDownload;
  }
}

/**
 * Hand a presigned URL to the browser. The object is served as an attachment,
 * so navigating to it saves the file under its original name.
 */
export function downloadViaAnchor(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
