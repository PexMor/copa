import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopaAuthError, createApi, createAuthProvider, StaticTokenProvider } from '../src/auth';
import type { EndpointConfig } from '../src/config';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const endpoint = (auth: EndpointConfig['auth']): EndpointConfig =>
  ({ id: 'a', url: 'https://c.test', namespace: 'team', auth });

afterEach(() => { vi.unstubAllGlobals(); });

describe('StaticTokenProvider: inline token', () => {
  it('produces a Bearer header and is ready', async () => {
    const p = new StaticTokenProvider({ method: 'static-token', token: 'abc' });
    expect(p.state()).toBe('ready');
    expect(await p.getHeader()).toBe('Bearer abc');
  });

  it('cannot refresh an inline token', async () => {
    const p = new StaticTokenProvider({ method: 'static-token', token: 'abc' });
    expect(await p.refresh()).toBe(false);
  });
});

describe('StaticTokenProvider: host-provided token (tokenFrom)', () => {
  it('asks the host every time and never caches', async () => {
    const src = vi.fn().mockResolvedValueOnce('t1').mockResolvedValueOnce('t2');
    const p = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'host' }, { host: src });
    expect(await p.getHeader()).toBe('Bearer t1');
    expect(await p.getHeader()).toBe('Bearer t2');
    expect(src).toHaveBeenCalledTimes(2);
  });

  it('is signed-out and rejects when no provider is registered', async () => {
    const p = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'host' }, {});
    expect(p.state()).toBe('signed-out');
    await expect(p.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });

  it('picks up a provider registered later', async () => {
    const sources: Record<string, () => string> = {};
    const p = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'host' }, sources);
    expect(p.state()).toBe('signed-out');
    sources.host = () => 'late';
    expect(p.state()).toBe('ready');
    expect(await p.getHeader()).toBe('Bearer late');
  });

  it('rejects when the provider returns nothing or throws, without leaking text', async () => {
    const empty = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'h' }, { h: () => '' });
    await expect(empty.getHeader()).rejects.toMatchObject({ code: 'no-token' });
    const boom = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'h' }, { h: () => { throw new Error('secret-xyz'); } });
    const err = await boom.getHeader().catch((e) => e);
    expect(err).toBeInstanceOf(CopaAuthError);
    expect(err.message).not.toContain('secret-xyz');
  });

  it('notifies subscribers when the state changes', async () => {
    let value: string | null = 'ok';
    const p = new StaticTokenProvider({ method: 'static-token', tokenFrom: 'h' }, { h: () => value });
    const seen: string[] = [];
    p.onChange((s) => seen.push(s));
    await p.getHeader();
    value = null;
    await p.getHeader().catch(() => {});
    expect(seen).toEqual(['signed-out']);
  });
});

describe('401 handling through the API client', () => {
  it('retries once with the rotated host token', async () => {
    let token = 'old';
    const f = vi.fn()
      // the host rotates its token while the first request is in flight
      .mockImplementationOnce(async () => { token = 'new'; return json({ error: 'unauthorized' }, 401); })
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal('fetch', f);
    const ep = endpoint({ method: 'static-token', tokenFrom: 'h' });
    const api = createApi(ep, createAuthProvider(ep, { tokenSources: { h: () => token } }));
    await api.history();
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('gives up when the host token did not change', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', f);
    const ep = endpoint({ method: 'static-token', tokenFrom: 'h' });
    const api = createApi(ep, createAuthProvider(ep, { tokenSources: { h: () => 'same' } }));
    await expect(api.history()).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does not retry an inline token after 401', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', f);
    const ep = endpoint({ method: 'static-token', token: 'abc' });
    await expect(createApi(ep, createAuthProvider(ep)).history()).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sends the endpoint namespace and base URL', async () => {
    const f = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal('fetch', f);
    const ep = endpoint({ method: 'static-token', token: 'abc' });
    await createApi(ep, createAuthProvider(ep)).history();
    expect(f.mock.calls[0][0]).toBe('https://c.test/api/history');
    expect(f.mock.calls[0][1].headers['X-Copa-Namespace']).toBe('team');
  });

  it('createAuthProvider rejects a method it does not know', () => {
    expect(() => createAuthProvider(endpoint({ method: 'kerberos' } as never))).toThrowError(/unsupported/);
  });
});
