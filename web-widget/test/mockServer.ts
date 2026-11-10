import { vi } from 'vitest';
import type { Capabilities, HistoryItem } from '../src/core';

export interface MockRequest { method: string; path: string; auth: string | null; ns: string | null; body?: string }

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    setTimeout(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }, 0);
  }
  send() { /* inbound frames are ignored by the server */ }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
  /** server → client frame */
  serverSend(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  /** the server (or network) drops the connection */
  serverClose() { this.close(); }
}

export interface MockServer {
  /** accept any bearer for which this returns true (besides `token`) */
  accept?: (token: string) => boolean;
  /** serve single-use event tickets (default: false → 404 like an older server) */
  tickets: boolean;
  /** open event sockets */
  sockets(): FakeWebSocket[];
  caps: Capabilities;
  clipboard: string;
  items: HistoryItem[];
  requests: MockRequest[];
  /** bytes received by the fake object store, by item id */
  stored: Map<string, number>;
  token: string;
  count(method: string, pathPrefix: string): number;
  addItem(item: Partial<HistoryItem> & { kind: HistoryItem['kind'] }): HistoryItem;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, error: string) => json({ error }, status);

class FakeXHR {
  static server: MockServer;
  static failWith: number | null = null;
  static hold: Promise<void> | null = null;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  private url = '';
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() { /* not needed */ }
  send(body: Blob) {
    void (FakeXHR.hold ?? Promise.resolve()).then(() => {
      const id = this.url.split('/').pop()!;
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size });
      if (FakeXHR.failWith) { this.status = FakeXHR.failWith; this.onload?.(); return; }
      FakeXHR.server.stored.set(id, body.size);
      this.status = 200;
      this.onload?.();
    });
  }
}

/** Pause object-store transfers until the returned function is called. */
export function holdUploads(): () => void {
  let release!: () => void;
  FakeXHR.hold = new Promise<void>((r) => { release = () => { FakeXHR.hold = null; r(); }; });
  return release;
}

export function setObjectStoreFailure(status: number | null) { FakeXHR.failWith = status; }

/** Installs fetch + XMLHttpRequest fakes implementing the copa HTTP API. */
export function mockServer(over: { caps?: Partial<Capabilities>; token?: string; items?: HistoryItem[] } = {}): MockServer {
  let seq = 0;
  const now = Date.now();
  const server: MockServer = {
    tickets: false,
    sockets: () => FakeWebSocket.instances.filter((w) => w.readyState === 1),
    token: over.token ?? 'tok',
    caps: {
      history: true, history_limit: 20, item_ttl_secs: 86400, files: true, max_file_size: 1024 * 1024,
      size_limit: 100, read: true, write: true, ...over.caps,
    },
    clipboard: '',
    items: over.items ? [...over.items] : [],
    requests: [],
    stored: new Map(),
    count(method, prefix) { return server.requests.filter((r) => r.method === method && r.path.startsWith(prefix)).length; },
    addItem(partial) {
      const item: HistoryItem = {
        id: `i${++seq}`, created_at: now, expires_at: now + 3600_000, size: 1, ...partial,
      } as HistoryItem;
      server.items.unshift(item);
      for (const w of server.sockets()) w.serverSend({ type: 'item_added', item });
      return item;
    },
  };
  FakeXHR.server = server;
  FakeXHR.failWith = null;
  FakeXHR.hold = null;

  FakeWebSocket.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const path = url.pathname;
    const body = typeof init.body === 'string' ? init.body : undefined;
    server.requests.push({ method, path, auth: headers.Authorization ?? null, ns: headers['X-Copa-Namespace'] ?? null, body });

    const bearer = (headers.Authorization ?? '').replace(/^Bearer /, '');
    if (headers.Authorization !== `Bearer ${server.token}` && !server.accept?.(bearer)) return err(401, 'unauthorized');
    const c = server.caps;
    const canRead = c.read !== false, canWrite = c.write !== false;

    if (method === 'POST' && path === '/api/events/ticket') {
      return server.tickets && canRead ? json({ ticket: `T${++seq}`, expires_at: Date.now() + 30_000 }) : err(404, 'not found');
    }
    if (method === 'GET' && path === '/api/capabilities') return json(c);
    if (path === '/api/clipboard') {
      if (method === 'GET') {
        return canRead ? new Response(server.clipboard, { headers: { 'content-type': 'text/plain' } }) : err(401, 'unauthorized');
      }
      if (!canWrite) return err(401, 'unauthorized');
      if (c.size_limit !== undefined && (body ?? '').length > c.size_limit) return err(413, 'too large');
      server.clipboard = body ?? '';
      server.addItem({ kind: 'text', preview: server.clipboard, size: server.clipboard.length });
      return new Response('', { status: 200 });
    }
    if (method === 'GET' && path === '/api/history') return canRead ? json(server.items) : err(401, 'unauthorized');
    const hist = /^\/api\/history\/([^/]+)$/.exec(path);
    if (hist) {
      const item = server.items.find((i) => i.id === hist[1]);
      if (!item) return err(404, 'not found');
      if (method === 'DELETE') {
        server.items = server.items.filter((i) => i !== item);
        for (const w of server.sockets()) w.serverSend({ type: 'item_removed', id: item.id, reason: 'deleted' });
        return new Response('', { status: 200 });
      }
      return new Response(item.preview ?? '', { headers: { 'content-type': 'text/plain' } });
    }
    if (method === 'POST' && path === '/api/files') {
      if (!c.files) return err(404, 'files not enabled');
      const req = JSON.parse(body ?? '{}') as { name: string; size: number; content_type?: string };
      const id = `f${++seq}`;
      pending.set(id, req);
      return json({ id, upload_url: `https://s3.test/put/${id}`, method: 'PUT', headers: {}, expires_at: Date.now() + 300_000 });
    }
    const complete = /^\/api\/files\/([^/]+)\/complete$/.exec(path);
    if (method === 'POST' && complete) {
      const req = pending.get(complete[1]);
      if (!req || !server.stored.has(complete[1])) return err(409, 'object missing');
      const item = server.addItem({ id: complete[1], kind: 'file', name: req.name, size: req.size, content_type: req.content_type });
      return json(item);
    }
    const file = /^\/api\/files\/([^/]+)$/.exec(path);
    if (method === 'GET' && file) {
      const item = server.items.find((i) => i.id === file[1]);
      if (!item) return err(404, 'not found');
      return json({ download_url: `https://s3.test/get/${item.id}?sig=abc`, name: item.name, size: item.size, content_type: item.content_type ?? 'application/octet-stream', expires_at: Date.now() + 300_000 });
    }
    return err(404, 'not found');
  }));
  const pending = new Map<string, { name: string; size: number; content_type?: string }>();
  return server;
}

/** Let unmount cleanups, socket-open timers and in-flight requests finish before globals are swapped. */
export const settle = () => new Promise<void>((r) => setTimeout(r, 25));
