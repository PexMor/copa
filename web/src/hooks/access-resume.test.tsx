import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopaServer } from '../types';
import { recheckAccess } from '../utils/access';
import { useCapabilities } from './useCapabilities';
import { useHistory } from './useHistory';
import { useServerVersion } from './useServerVersion';
import { useWebSocket } from './useWebSocket';

const server: CopaServer = { id: 's1', name: 'own', type: 'copa', url: location.origin, token: 't' };

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  close() { /* closing is driven by the test */ }
  /** Server/proxy dropped the connection. */
  drop() { this.onclose?.(); }
}

type ProbeMode = 'ready' | 'expired' | 'broken';
let probeMode: ProbeMode;
let requests: string[];

function probeReply(): Response {
  if (probeMode === 'ready') {
    return { status: 204, type: 'basic', headers: new Headers({ 'x-app-access-probe': 'ok' }) } as unknown as Response;
  }
  if (probeMode === 'expired') return { status: 302, type: 'opaqueredirect', headers: new Headers() } as unknown as Response;
  return { status: 500, type: 'basic', headers: new Headers() } as unknown as Response;
}

const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  requests.push(url);
  if (url.includes('/__access/probe')) return probeReply();
  if (url.includes('/api/version')) {
    return Response.json({ name: 'copasrv', version: '1.0.0', commit: 'abc', built: '', protocol: 1 });
  }
  if (url.includes('/api/history')) return Response.json([]);
  return Response.json({ history: false, files: false });
});

let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  requests = [];
  probeMode = 'ready';
  fetchStub.mockClear();
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  render(null, host);
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const count = (needle: string) => requests.filter((u) => u.includes(needle)).length;

/** Let pending promise callbacks (probe → decision) run. */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Expire the session, then confirm it valid again, as the retry button would. */
async function expireThenRestore() {
  probeMode = 'expired';
  await act(async () => { await recheckAccess(); });
  probeMode = 'ready';
  await act(async () => { await recheckAccess(); });
}

function WsHarness() {
  useWebSocket({ server, namespace: 'n', enabled: true, onMessage: () => {} });
  return null;
}

function HistoryHarness() {
  useHistory({ server, namespace: 'n', enabled: true, live: true });
  return null;
}

function CapsHarness() {
  useCapabilities(server, 'n');
  useServerVersion(server, 'connected');
  return null;
}

describe('useWebSocket and the access gate', () => {
  it('offline/unreachable close keeps retrying with the normal backoff', async () => {
    await act(async () => { render(<WsHarness />, host); });
    expect(FakeSocket.all).toHaveLength(1);

    probeMode = 'broken';
    FakeSocket.all[0].drop();
    await flush();
    await advance(3000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('expired session schedules no reconnect; one restore creates exactly one new socket', async () => {
    await act(async () => { render(<WsHarness />, host); });
    expect(FakeSocket.all).toHaveLength(1);

    probeMode = 'expired';
    FakeSocket.all[0].drop();
    await flush();
    await advance(10_000);
    expect(FakeSocket.all).toHaveLength(1); // paused, nothing scheduled

    probeMode = 'ready';
    await act(async () => { await recheckAccess(); });
    await advance(10_000);
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe('useHistory and the access gate', () => {
  it('expired session schedules no reconnect; restore refreshes the list and reconnects once', async () => {
    await act(async () => { render(<HistoryHarness />, host); });
    expect(FakeSocket.all).toHaveLength(1);
    const listBefore = count('/api/history');

    probeMode = 'expired';
    FakeSocket.all[0].drop();
    await flush();
    await advance(10_000);
    expect(FakeSocket.all).toHaveLength(1);

    probeMode = 'ready';
    await act(async () => { await recheckAccess(); });
    await advance(10_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(count('/api/history')).toBeGreaterThan(listBefore); // refreshed
  });
});

describe('useCapabilities / useServerVersion and the access gate', () => {
  it('a restore triggers one new request each', async () => {
    await act(async () => { render(<CapsHarness />, host); });
    await advance(300); // capabilities debounce
    const caps = count('/api/capabilities');
    const version = count('/api/version');
    expect(caps).toBe(1);
    expect(version).toBe(1);

    await expireThenRestore();
    await advance(300);
    expect(count('/api/capabilities')).toBe(caps + 1);
    expect(count('/api/version')).toBe(version + 1);
  });
});
