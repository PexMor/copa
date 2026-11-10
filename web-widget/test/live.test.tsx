import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveEvents, CopaSession, eventsUrl, type LiveState } from '../src';
import { CopaShare, type CopaHandle } from '../src/ui';
import { FakeWebSocket, mockServer, type MockServer, settle } from './mockServer';

const endpoint = (auth: unknown = { method: 'static-token', token: 'tok' }) =>
  ({ id: 'main', url: 'https://copa.test', namespace: 'team', auth });
const cfg = (auth?: unknown) => ({ version: 1, endpoints: [endpoint(auth)] });

let root: HTMLElement;
let server: MockServer;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); server = mockServer(); });
afterEach(async () => { render(null, root); await settle(); root.remove(); vi.unstubAllGlobals(); });

const q = (sel: string) => root.querySelector(sel);
async function mountLive(props: Record<string, unknown> = {}) {
  render(<CopaShare config={cfg()} {...props} />, root);
  await vi.waitFor(() => expect(q('[data-role="live-state"]')?.getAttribute('data-state')).toBe('live'));
}

describe('eventsUrl', () => {
  it('maps http(s) to ws(s) and appends the events path', () => {
    expect(eventsUrl('https://copa.example.com').toString()).toBe('wss://copa.example.com/ws/events');
    expect(eventsUrl('http://127.0.0.1:8080/').toString()).toBe('ws://127.0.0.1:8080/ws/events');
    expect(eventsUrl('https://h.example/sub/').toString()).toBe('wss://h.example/sub/ws/events');
  });
});

describe('widget live updates', () => {
  it('an item added by another client appears without user action', async () => {
    await mountLive();
    expect(q('.copa-history li')).toBeNull();
    server.addItem({ kind: 'file', name: 'from-phone.png', content_type: 'application/octet-stream' }); // second client
    await vi.waitFor(() => expect(q('.copa-history li')?.textContent).toContain('from-phone.png'));
  });

  it('an item removed elsewhere disappears', async () => {
    const item = server.addItem({ kind: 'text', preview: 'temp' });
    await mountLive();
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"]`)).not.toBeNull());
    server.sockets()[0].serverSend({ type: 'item_removed', id: item.id, reason: 'expired' });
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"]`)).toBeNull());
  });

  it('ignores frames it does not understand', async () => {
    await mountLive();
    server.sockets()[0].onmessage!({ data: 'not json' });
    server.sockets()[0].serverSend({ type: 'mystery' });
    expect(q('[data-role="live-state"]')?.getAttribute('data-state')).toBe('live');
  });

  it('own shares are listed and reported once even though the stream echoes them', async () => {
    const onItem = vi.fn();
    let handle!: CopaHandle;
    await mountLive({ onItem, onReady: (h: CopaHandle) => { handle = h; } });
    await handle.share('echo me');
    await vi.waitFor(() => expect(root.querySelectorAll('.copa-history li').length).toBe(1));
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it('reports items from other clients through onItem once', async () => {
    const onItem = vi.fn();
    await mountLive({ onItem });
    const item = server.addItem({ kind: 'text', preview: 'remote' });
    await vi.waitFor(() => expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ id: item.id })));
    server.sockets()[0].serverSend({ type: 'item_added', item });
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it('uses a single-use ticket instead of the token when the server offers one', async () => {
    server.tickets = true;
    await mountLive();
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/ws/events');
    expect(url.searchParams.get('namespace')).toBe('team');
    expect(url.searchParams.get('ticket')).toMatch(/^T/);
    expect(url.searchParams.has('token')).toBe(false);
  });

  it('falls back to ?token= for a static token on a server without tickets', async () => {
    await mountLive();
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get('token')).toBe('tok');
    expect(url.searchParams.has('ticket')).toBe(false);
  });

  it('resyncs after a reconnect: items added while offline show up', async () => {
    await mountLive();
    const first = server.sockets()[0];
    first.serverClose();
    await vi.waitFor(() => expect(q('[data-role="live-state"]')?.getAttribute('data-state')).toBe('reconnecting'));
    server.addItem({ kind: 'text', preview: 'missed while offline' }); // no socket open: no frame
    expect(q('.copa-history li')).toBeNull();
    await vi.waitFor(() => expect(q('[data-role="live-state"]')?.getAttribute('data-state')).toBe('live'), { timeout: 4000 });
    await vi.waitFor(() => expect(q('.copa-history li')?.textContent).toContain('missed while offline'));
  });

  it('stops the stream when the widget is removed', async () => {
    await mountLive();
    const ws = server.sockets()[0];
    render(null, root);
    await vi.waitFor(() => expect(ws.readyState).toBe(3));
  });

  it('without history there is no live connection', async () => {
    server.caps.history = false;
    render(<CopaShare config={cfg()} />, root);
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe('LiveEvents', () => {
  const session = (auth?: unknown) => {
    const s = new CopaSession(endpoint(auth) as never, { tokenSources: {} });
    return s;
  };
  const collect = () => {
    const states: LiveState[] = [];
    return { states, onState: (s: LiveState) => { states.push(s); } };
  };

  it('manual refresh only: no ticket support and a non-static auth method → unavailable, no retries', async () => {
    const s = session();
    // pretend this endpoint authenticates with a refreshable token (oauth2/pairing)
    Object.defineProperty(s.provider, 'method', { value: 'oauth2' });
    const { states, onState } = collect();
    const live = new LiveEvents(s, { onEvent: () => {}, onState, delays: [5] });
    live.start();
    await vi.waitFor(() => expect(live.current).toBe('unavailable'));
    await new Promise((r) => setTimeout(r, 40));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(states).toEqual(['connecting', 'unavailable']);
    live.stop();
  });

  it('backs off between failed attempts and recovers', async () => {
    const s = session();
    let failTickets = 3;
    const f = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      if (String(u).endsWith('/api/events/ticket') && failTickets-- > 0) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return f(u, init);
    }));
    await s.loadCapabilities();
    const connected = vi.fn();
    const times: number[] = [];
    const { onState } = collect();
    const live = new LiveEvents(s, { onEvent: () => {}, onState: (st) => { if (st === 'reconnecting') times.push(Date.now()); onState(st); }, onConnected: connected, delays: [20, 40, 80] });
    live.start();
    await vi.waitFor(() => expect(live.current).toBe('live'), { timeout: 2000 });
    expect(connected).toHaveBeenCalledTimes(1);
    expect(times.length).toBeGreaterThanOrEqual(1);
    live.stop();
  });

  it('stop() closes the socket and never reconnects', async () => {
    const s = session();
    await s.loadCapabilities();
    const live = new LiveEvents(s, { onEvent: () => {}, delays: [5] });
    live.start();
    await vi.waitFor(() => expect(live.current).toBe('live'));
    const ws = FakeWebSocket.instances[0];
    live.stop();
    expect(ws.readyState).toBe(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(live.current).toBe('stopped');
  });
});
