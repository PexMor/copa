import { ApiError, type HistoryEvent } from './core';
import type { CopaSession } from './session';

export type LiveState = 'connecting' | 'live' | 'reconnecting' | 'unavailable' | 'stopped';

export interface LiveOptions {
  onEvent: (event: HistoryEvent) => void;
  onState?: (state: LiveState) => void;
  /** Called after every successful (re)connect so the list can resync what was missed. */
  onConnected?: () => void;
  /** Backoff delays in ms; the last one repeats. */
  delays?: number[];
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

/** `https://h/p` → `wss://h/ws/events`. */
export function eventsUrl(baseUrl: string): URL {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws/events`;
  u.search = '';
  return u;
}

/**
 * Live item events with reconnect and backoff.
 *
 * Browsers cannot set headers on a WebSocket upgrade, so the credential is
 * passed in the query string — but never the long-lived one when avoidable:
 * a single-use ticket from `POST /api/events/ticket` is preferred. A server
 * without tickets (404) falls back to `?token=` for static tokens only; for
 * every other auth method live updates are then unavailable and the widget
 * relies on manual refresh.
 */
export class LiveEvents {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private state: LiveState = 'stopped';

  constructor(private readonly session: CopaSession, private readonly opts: LiveOptions) {}

  get current(): LiveState { return this.state; }

  private set(state: LiveState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onState?.(state);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.set('connecting');
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; try { ws.close(); } catch { /* already closed */ } }
    this.set('stopped');
  }

  /** Query credential for the upgrade, or null when live updates cannot be authenticated. */
  private async credential(): Promise<{ key: 'ticket' | 'token'; value: string } | null> {
    try {
      const res = await this.session.api.request('/api/events/ticket', { method: 'POST' });
      const body = await res.json() as { ticket?: string };
      if (body.ticket) return { key: 'ticket', value: body.ticket };
    } catch (e) {
      const missing = e instanceof ApiError && (e.status === 404 || e.status === 405);
      if (!missing) throw e; // auth/network problem: retried with backoff
    }
    if (this.session.provider.method === 'static-token') {
      const header = await this.session.provider.getHeader();
      return { key: 'token', value: header.replace(/^Bearer /, '') };
    }
    return null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let cred: Awaited<ReturnType<LiveEvents['credential']>>;
    try {
      cred = await this.credential();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    if (!cred) { this.set('unavailable'); return; }

    const url = eventsUrl(this.session.endpoint.url);
    url.searchParams.set('namespace', this.session.endpoint.namespace);
    url.searchParams.set(cred.key, cred.value);

    const WS = this.opts.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try { ws = new WS(url.toString()); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.set('live');
      this.opts.onConnected?.();
    };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(String(m.data)) as HistoryEvent;
        if (ev && (ev.type === 'item_added' || ev.type === 'item_removed')) this.opts.onEvent(ev);
      } catch { /* ignore frames we do not understand */ }
    };
    ws.onerror = () => { /* followed by close */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.set('reconnecting');
    const delays = this.opts.delays ?? DEFAULT_DELAYS;
    const base = delays[Math.min(this.attempts, delays.length - 1)];
    this.attempts++;
    const jitter = Math.floor(base * 0.2 * Math.random());
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, base + jitter);
  }
}
