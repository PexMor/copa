import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Access = typeof import('./access');

/** Module state (expired flag, epoch, in-flight probe) is global: load fresh per test. */
async function load(): Promise<Access> {
  vi.resetModules();
  return import('./access');
}

function reply(init: { status: number; type?: string; probe?: boolean }) {
  return {
    status: init.status,
    type: init.type ?? 'basic',
    headers: new Headers(init.probe ? { 'x-app-access-probe': 'ok' } : {}),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeAccess classification', () => {
  const cases: [string, Response, string][] = [
    ['204 + header', reply({ status: 204, probe: true }), 'ready'],
    ['204 without header', reply({ status: 204 }), 'error'],
    ['302', reply({ status: 302 }), 'needs-auth'],
    ['opaqueredirect', reply({ status: 0, type: 'opaqueredirect' }), 'needs-auth'],
    ['401', reply({ status: 401 }), 'needs-auth'],
    ['403', reply({ status: 403 }), 'needs-auth'],
    ['404 (no proxy)', reply({ status: 404 }), 'ready'],
    ['500', reply({ status: 500 }), 'error'],
    ['200 HTML', reply({ status: 200 }), 'error'],
  ];

  for (const [name, res, want] of cases) {
    it(`${name} → ${want}`, async () => {
      fetchMock.mockResolvedValue(res);
      const { probeAccess } = await load();
      expect(await probeAccess()).toBe(want);
    });
  }

  it('sends a manual-redirect, no-store, credentialed GET', async () => {
    fetchMock.mockResolvedValue(reply({ status: 204, probe: true }));
    const { probeAccess } = await load();
    await probeAccess();
    expect(fetchMock).toHaveBeenCalledWith('/__access/probe', expect.objectContaining({
      method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual',
    }));
  });

  it('thrown error while online → error, never needs-auth', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    fetchMock.mockRejectedValue(new TypeError('failed'));
    const { probeAccess } = await load();
    expect(await probeAccess()).toBe('error');
  });

  it('thrown error while offline → offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fetchMock.mockRejectedValue(new TypeError('failed'));
    const { probeAccess } = await load();
    expect(await probeAccess()).toBe('offline');
  });
});

describe('ensureAccess', () => {
  it('shares one in-flight probe between concurrent callers', async () => {
    fetchMock.mockResolvedValue(reply({ status: 204, probe: true }));
    const { ensureAccess } = await load();
    const results = await Promise.all([ensureAccess(), ensureAccess(), ensureAccess()]);
    expect(results).toEqual(['ready', 'ready', 'ready']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('restore epoch', () => {
  const ready = () => fetchMock.mockResolvedValue(reply({ status: 204, probe: true }));
  const expiredReply = () => fetchMock.mockResolvedValue(reply({ status: 302 }));

  it('increments only on expired → ready', async () => {
    const a = await load();
    const onRestore = vi.fn();
    a.subscribeRestored(onRestore);

    ready();
    await a.recheckAccess(); // ready → ready
    expect(a.getAccessEpoch()).toBe(0);

    expiredReply();
    await a.recheckAccess();
    expect(a.isExpired()).toBe(true);
    expect(a.getAccessEpoch()).toBe(0);

    ready();
    await a.recheckAccess(); // expired → ready
    expect(a.isExpired()).toBe(false);
    expect(a.getAccessEpoch()).toBe(1);
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(1);

    await a.recheckAccess(); // ready → ready again
    expect(a.getAccessEpoch()).toBe(1);
  });

  it('offline/error results leave the epoch and the expired flag alone', async () => {
    const a = await load();
    expiredReply();
    await a.recheckAccess();

    fetchMock.mockResolvedValue(reply({ status: 500 }));
    expect(await a.recheckAccess()).toBe('error');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    fetchMock.mockRejectedValue(new TypeError('failed'));
    expect(await a.recheckAccess()).toBe('offline');

    expect(a.isExpired()).toBe(true);
    expect(a.getAccessEpoch()).toBe(0);
  });
});

describe('canConnect', () => {
  it('is ready for a cross-origin server without probing', async () => {
    const a = await load();
    expect(await a.canConnect('https://other.example')).toBe('ready');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps probe results for the own origin', async () => {
    const a = await load();
    const own = location.origin;

    fetchMock.mockResolvedValue(reply({ status: 204, probe: true }));
    expect(await a.canConnect(own)).toBe('ready');

    fetchMock.mockResolvedValue(reply({ status: 302 }));
    expect(await a.canConnect(own)).toBe('needs-auth');

    fetchMock.mockResolvedValue(reply({ status: 500 }));
    expect(await a.canConnect(own)).toBe('paused');
  });

  it('concurrent calls share one probe request', async () => {
    fetchMock.mockResolvedValue(reply({ status: 204, probe: true }));
    const a = await load();
    await Promise.all([a.canConnect(location.origin), a.canConnect(location.origin)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loginEntryUrl', () => {
  it('encodes path, query and hash into the return target', async () => {
    window.history.replaceState(null, '', '/app/x?a=1&b=two#token=x&url=y');
    const { loginEntryUrl } = await load();
    const url = loginEntryUrl();
    expect(url.startsWith('/__access/login?return=')).toBe(true);
    const encoded = url.slice('/__access/login?return='.length);
    // the hash must be percent-encoded so it reaches the server in the query
    expect(encoded).not.toContain('#');
    expect(encoded).not.toContain('&');
    expect(decodeURIComponent(encoded)).toBe('/app/x?a=1&b=two#token=x&url=y');
  });
});

describe('login-loop guard', () => {
  it('allows the first automatic navigation', async () => {
    const a = await load();
    expect(a.mayAutoLogin()).toBe(true);
  });

  it('blocks a second one within the window', async () => {
    const a = await load();
    a.markAutoLogin(1_000);
    expect(a.mayAutoLogin(1_000 + a.LOGIN_LOOP_WINDOW_MS - 1)).toBe(false);
  });

  it('allows again once the stamp is stale', async () => {
    const a = await load();
    a.markAutoLogin(1_000);
    expect(a.mayAutoLogin(1_000 + a.LOGIN_LOOP_WINDOW_MS)).toBe(true);
  });

  it('allows again after the stamp is cleared', async () => {
    const a = await load();
    a.markAutoLogin(1_000);
    a.clearAutoLogin();
    expect(a.mayAutoLogin(1_001)).toBe(true);
  });

  it('degrades to always navigating when storage throws', async () => {
    const a = await load();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(a.mayAutoLogin()).toBe(true);
    expect(() => a.markAutoLogin()).not.toThrow();
    expect(() => a.clearAutoLogin()).not.toThrow();
  });
});
