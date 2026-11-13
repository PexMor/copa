import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopaServer } from '../types';
import { fetchServerVersion } from '../utils/version';
import { useClipboard } from './useClipboard';
import { useServerVersion } from './useServerVersion';

const server: CopaServer = { id: 's1', name: 'own', type: 'copa', url: location.origin, token: 't' };

const LOGIN_PAGE = () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
const PROBE_READY = () => ({ status: 204, type: 'basic', headers: new Headers({ 'x-app-access-probe': 'ok' }) }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
let host: HTMLElement;

const probeCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/__access/probe')).length;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  render(null, host);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Route probe requests to a ready answer, everything else to `api`. */
function route(api: () => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
    String(url).includes('/__access/probe') ? PROBE_READY() : api());
}

describe('useClipboard', () => {
  type Clip = ReturnType<typeof useClipboard>;
  let clip: Clip;
  function Harness() { clip = useClipboard(server, 'n'); return null; }
  const mount = () => act(async () => { render(<Harness />, host); });

  it('push with a 200 HTML login page is an error and re-checks the session', async () => {
    route(LOGIN_PAGE);
    await mount();
    await act(async () => { await clip.push('hello'); });
    expect(clip.status).toBe('error');
    expect(clip.lastSync).toBeNull();
    expect(probeCalls()).toBeGreaterThan(0);
  });

  it('pull with an HTML login page is an error and does not store the page', async () => {
    route(LOGIN_PAGE);
    await mount();
    await act(async () => { await clip.pull(); });
    expect(clip.status).toBe('error');
    expect(clip.content).toBe('');
    expect(probeCalls()).toBeGreaterThan(0);
  });

  it('network error is an error and re-checks the session', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes('/__access/probe')) return PROBE_READY();
      throw new TypeError('failed');
    });
    await mount();
    await act(async () => { await clip.push('hello'); });
    expect(clip.status).toBe('error');
    expect(probeCalls()).toBeGreaterThan(0);
  });

  it('normal text round trip still works and does not probe', async () => {
    route(() => new Response('data', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await mount();
    await act(async () => { await clip.pull(); });
    expect(clip.status).toBe('ok');
    expect(clip.content).toBe('data');
    await act(async () => { await clip.push('x'); });
    expect(clip.status).toBe('ok');
    expect(probeCalls()).toBe(0);
  });

  it('401 from the API is a token problem, not a session expiry', async () => {
    route(() => Response.json({ error: 'bad token' }, { status: 401 }));
    await mount();
    await act(async () => { await clip.pull(); });
    expect(clip.status).toBe('error');
    expect(probeCalls()).toBe(0);
  });
});

describe('fetchServerVersion outcomes', () => {
  const info = { name: 'copasrv', version: '1.2.3', commit: 'abc', built: '', protocol: 1 };

  it('valid payload → ok', async () => {
    fetchMock.mockResolvedValue(Response.json(info));
    const r = await fetchServerVersion(server);
    expect(r).toEqual({ kind: 'ok', info });
  });

  it('404 → none (older copasrv)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    expect(await fetchServerVersion(server)).toEqual({ kind: 'none' });
  });

  it('JSON without version fields → none', async () => {
    fetchMock.mockResolvedValue(Response.json({ hello: 'world' }));
    expect(await fetchServerVersion(server)).toEqual({ kind: 'none' });
  });

  it('HTML login page → unexpected', async () => {
    fetchMock.mockResolvedValue(LOGIN_PAGE());
    expect(await fetchServerVersion(server)).toEqual({ kind: 'unexpected' });
  });

  it('network error → unexpected', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed'));
    expect(await fetchServerVersion(server)).toEqual({ kind: 'unexpected' });
  });
});

describe('useServerVersion', () => {
  function Harness() { useServerVersion(server, 'connected'); return null; }
  /** Mount, then let the fetch → json → state chain finish. */
  const mount = async () => {
    await act(async () => { render(<Harness />, host); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };

  it('only "unexpected" re-checks the session and nothing is logged as an older copasrv', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    route(LOGIN_PAGE);
    await mount();
    expect(probeCalls()).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('"none" logs the older-copasrv warning and does not probe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    route(() => new Response('', { status: 404 }));
    await mount();
    expect(warn).toHaveBeenCalledOnce();
    expect(probeCalls()).toBe(0);
  });

  it('"ok" neither warns nor probes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    route(() => Response.json({ name: 'copasrv', version: '1.0.0', commit: 'abc', built: '', protocol: 1 }));
    await mount();
    expect(warn).not.toHaveBeenCalled();
    expect(probeCalls()).toBe(0);
  });
});
