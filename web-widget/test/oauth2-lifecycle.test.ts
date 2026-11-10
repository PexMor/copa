// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi, type AuthState } from '../src/auth';
import { OAuth2Provider } from '../src/auth/oauth2';
import type { EndpointConfig, OAuth2Auth } from '../src/config';
import { hasIssuer, startIssuer, type Issuer } from './issuer';
import { fakeEnv, fakeLocks, loginAs, memoryStorage, type Fake, type FakeOptions } from './oauth-env';

const run = hasIssuer ? describe : describe.skip;

let normal: Issuer;      // 10 minute access tokens
let shortAccess: Issuer; // access tokens always inside the 60 s renewal margin
let shortRefresh: Issuer; // refresh tokens that the *server* expires after 1 s
beforeAll(async () => {
  if (!hasIssuer) return;
  [normal, shortAccess, shortRefresh] = await Promise.all([
    startIssuer(),
    startIssuer(['--access-ttl', '50']),
    startIssuer(['--refresh-ttl', '1']),
  ]);
}, 60_000);
afterAll(async () => { await Promise.all([normal, shortAccess, shortRefresh].filter(Boolean).map((i) => i.stop())); });
afterEach(() => { vi.unstubAllGlobals(); });

const endpointFor = (auth: OAuth2Auth): EndpointConfig => ({ id: 'main', url: 'https://copa.example.com', namespace: 'team', auth });

interface Rig {
  provider: OAuth2Provider;
  fake: Fake;
  states: AuthState[];
  count(suffix: string): number;
}

function rig(issuer: Issuer, auth: Partial<OAuth2Auth> = {}, over: Partial<FakeOptions> = {}): Rig {
  let fake!: Fake;
  fake = fakeEnv({ script: (p, u) => loginAs(() => fake)(p, u), ...over });
  const a: OAuth2Auth = { method: 'oauth2', tokenService: issuer.url, ...auth };
  const provider = new OAuth2Provider(endpointFor(a), a, fake.env);
  const states: AuthState[] = [];
  provider.onChange((s) => states.push(s));
  return { provider, fake, states, count: (suffix) => fake.fetchLog.filter((c) => c.url.endsWith(suffix)).length };
}

const jwt = (header: string) => header.replace('Bearer ', '');
const claims = (header: string) => JSON.parse(Buffer.from(jwt(header).split('.')[1], 'base64url').toString());
const until = (fn: () => boolean, ms = 3000) => vi.waitFor(() => expect(fn()).toBe(true), { timeout: ms });

run('token lifecycle', () => {
  // ── renewal ─────────────────────────────────────────────────────────────────
  it('does not touch the service while the access token has plenty of life left', async () => {
    const r = rig(normal);
    await r.provider.signIn();
    const first = await r.provider.getHeader();
    for (let i = 0; i < 5; i++) expect(await r.provider.getHeader()).toBe(first);
    expect(r.count('/refresh')).toBe(0);
  });

  it('renews an access token with less than a minute left, before using it', async () => {
    const r = rig(shortAccess);
    await r.provider.signIn();
    const before = await r.provider.getHeader(); // already inside the margin -> renewed on use
    expect(r.count('/refresh')).toBe(1);
    const after = await r.provider.getHeader();
    expect(after).not.toBe(before);
    expect(claims(before).jti).not.toBe(claims(after).jti);
    expect(claims(after).sub).toBe('alice');
    expect(r.provider.state()).toBe('ready');
  });

  it('renews only once for concurrent users (single flight)', async () => {
    const r = rig(shortAccess);
    await r.provider.signIn();
    const headers = await Promise.all(Array.from({ length: 8 }, () => r.provider.getHeader()));
    expect(r.count('/refresh')).toBe(1);
    expect(new Set(headers).size).toBe(1);
  });

  it('rotates the refresh token: the old one stops working', async () => {
    const r = rig(shortAccess);
    await r.provider.signIn();
    await r.provider.getHeader(); // renew
    const sent = JSON.parse(r.fake.fetchLog.find((c) => c.url.endsWith('/refresh'))!.body!).refresh_token as string;
    const replay = await fetch(`${shortAccess.url}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sent }) });
    expect(replay.status).toBe(400); // already consumed by the widget's renewal
  });

  // ── 401 handling through the API client ──────────────────────────────────────
  it('retries a 401 once with a renewed token', async () => {
    const r = rig(shortAccess);
    await r.provider.signIn();
    const seen: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith('https://copa.example.com')) return real(input, init);
      seen.push((init?.headers as Record<string, string>).Authorization);
      return seen.length === 1
        ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const api = createApi(endpointFor({ method: 'oauth2', tokenService: shortAccess.url }), r.provider);
    expect(await api.history()).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(claims(seen[0]).jti).not.toBe(claims(seen[1]).jti);
  });

  it('does not loop when the renewed token is refused too', async () => {
    const r = rig(normal);
    await r.provider.signIn();
    const real = globalThis.fetch;
    let copaCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith('https://copa.example.com')) return real(input, init);
      copaCalls++;
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }));
    const api = createApi(endpointFor({ method: 'oauth2', tokenService: normal.url }), r.provider);
    await expect(api.history()).rejects.toMatchObject({ status: 401 });
    expect(copaCalls).toBe(2);
  });

  // ── refresh failing ──────────────────────────────────────────────────────────
  it('signs out (expired) when the service rejects the refresh token, and offers sign-in again', async () => {
    const r = rig(shortRefresh, {}, {});
    await r.provider.signIn();
    await new Promise((res) => setTimeout(res, 1300)); // the server expires the refresh token after 1 s
    expect(await r.provider.refresh()).toBe(false);
    expect(r.provider.state()).toBe('expired');
    expect(r.states[r.states.length - 1]).toBe("expired");
    await expect(r.provider.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
    // sign in again works
    await r.provider.signIn();
    expect(r.provider.state()).toBe('ready');
    expect(claims(await r.provider.getHeader()).sub).toBe('alice');
  });

  it('knows locally that the refresh token has expired and does not even ask', async () => {
    let skew = 0;
    const r = rig(normal, {}, { now: () => Date.now() + skew });
    await r.provider.signIn();
    skew = 40 * 24 * 3600 * 1000; // 40 days later: past the 24 h refresh lifetime
    expect(await r.provider.refresh()).toBe(false);
    expect(r.provider.state()).toBe('expired');
    expect(r.count('/refresh')).toBe(0);
  });

  it('a network failure during renewal does not sign the user out', async () => {
    let down = false;
    const r = rig(shortAccess, {}, { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down && String(input).endsWith('/refresh')) throw new TypeError('offline');
      return fetch(input, init);
    }) as typeof fetch });
    await r.provider.signIn();
    down = true;
    expect(await r.provider.refresh()).toBe(false);
    expect(r.provider.state()).toBe('ready');
    expect((await r.provider.getHeader()).startsWith('Bearer ')).toBe(true); // the still-valid token keeps working
    down = false;
    expect(await r.provider.refresh()).toBe(true);
  });

  it('a server error during renewal does not sign the user out either', async () => {
    let broken = false;
    const r = rig(shortAccess, {}, { fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      broken && String(input).endsWith('/refresh') ? new Response('boom', { status: 503 }) : fetch(input, init)) as typeof fetch });
    await r.provider.signIn();
    broken = true;
    expect(await r.provider.refresh()).toBe(false);
    expect(r.provider.state()).toBe('ready');
  });

  // ── persistence ──────────────────────────────────────────────────────────────
  it('by default nothing is stored and a reload means signing in again', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const r = rig(normal, {}, { storage });
    await r.provider.signIn();
    expect(storage.session.length + storage.local.length).toBe(0);
    const reloaded = rig(normal, {}, { storage });
    expect(reloaded.provider.state()).toBe('signed-out');
    await expect(reloaded.provider.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });

  for (const kind of ['session', 'local'] as const) {
    it(`persist=${kind}: only the refresh token is stored, and a reload restores the session`, async () => {
      const storage = { session: memoryStorage(), local: memoryStorage() };
      const first = rig(normal, { persist: kind }, { storage });
      await first.provider.signIn();
      const access = jwt(await first.provider.getHeader());
      const raw = storage[kind].getItem('copa-widget:oauth2:main')!;
      expect(raw).toBeTruthy();
      expect(raw).not.toContain(access);                      // the access token is never persisted
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['e', 'r']);
      expect((kind === 'session' ? storage.local : storage.session).length).toBe(0);

      const reloaded = rig(normal, { persist: kind }, { storage });
      expect(reloaded.provider.state()).toBe('pending');
      expect((await reloaded.provider.getHeader()).startsWith('Bearer ')).toBe(true);
      expect(reloaded.provider.state()).toBe('ready');
      expect(reloaded.count('/refresh')).toBe(1);
      expect(claims(await reloaded.provider.getHeader()).sub).toBe('alice');
      // the rotated refresh token replaced the stored one
      expect(storage[kind].getItem('copa-widget:oauth2:main')).not.toBe(raw);
    });
  }

  it('an expired stored session is dropped without contacting the service', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.session.setItem('copa-widget:oauth2:main', JSON.stringify({ r: 'old', e: Date.now() - 1000 }));
    const r = rig(normal, { persist: 'session' }, { storage });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.provider.state()).toBe('signed-out');
    expect(r.fake.fetchLog).toHaveLength(0);
    expect(storage.session.getItem('copa-widget:oauth2:main')).toBeNull();
  });

  it('garbage in storage is ignored', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    for (const bad of ['not json', '{}', '{"r":5,"e":"x"}', 'null']) {
      storage.session.setItem('copa-widget:oauth2:main', bad);
      const r = rig(normal, { persist: 'session' }, { storage });
      await new Promise((res) => setTimeout(res, 20));
      expect(r.provider.state()).toBe('signed-out');
    }
  });

  it('a stored session the service no longer knows ends as expired', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.session.setItem('copa-widget:oauth2:main', JSON.stringify({ r: 'revoked-or-bogus', e: Date.now() + 3600_000 }));
    const r = rig(normal, { persist: 'session' }, { storage });
    await until(() => r.provider.state() !== 'pending');
    expect(r.provider.state()).toBe('expired');
    expect(storage.session.getItem('copa-widget:oauth2:main')).toBeNull();
  });

  it('works when storage is unavailable', async () => {
    const r = rig(normal, { persist: 'local' }, { storage: {} });
    await r.provider.signIn();
    expect((await r.provider.getHeader()).startsWith('Bearer ')).toBe(true);
  });

  // ── several tabs sharing one persisted session ───────────────────────────────
  it('two tabs refreshing the same stored session without coordination get cut off (why locking exists)', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const first = rig(shortAccess, { persist: 'local' }, { storage });
    await first.provider.signIn();
    // two tabs restore the same refresh token and refresh at the same time, with no lock
    const a = rig(shortAccess, { persist: 'local' }, { storage });
    const b = rig(shortAccess, { persist: 'local' }, { storage });
    await Promise.allSettled([a.provider.getHeader(), b.provider.getHeader()]);
    const states = [a.provider.state(), b.provider.state()];
    expect(states).toContain('expired');     // the service saw a reused token and revoked the session
  });

  it('with the cross-tab lock, tabs share the session and nobody is cut off', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const lock = fakeLocks();
    const first = rig(shortAccess, { persist: 'local' }, { storage, lock });
    await first.provider.signIn();
    const a = rig(shortAccess, { persist: 'local' }, { storage, lock });
    const b = rig(shortAccess, { persist: 'local' }, { storage, lock });
    const results = await Promise.allSettled([a.provider.getHeader(), b.provider.getHeader()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect([a.provider.state(), b.provider.state()]).toEqual(['ready', 'ready']);
    // and they can keep going
    await a.provider.getHeader();
    await b.provider.getHeader();
    expect([a.provider.state(), b.provider.state()]).toEqual(['ready', 'ready']);
  });

  // ── sign out ─────────────────────────────────────────────────────────────────
  it('sign-out clears the session locally and at the service', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const r = rig(normal, { persist: 'session' }, { storage });
    await r.provider.signIn();
    await r.provider.getHeader();
    // capture the refresh token the service knows about by renewing once through a second path
    const refreshBody = JSON.parse(storage.session.getItem('copa-widget:oauth2:main')!);
    await r.provider.signOut();
    expect(r.provider.state()).toBe('signed-out');
    expect(storage.session.getItem('copa-widget:oauth2:main')).toBeNull();
    expect(r.count('/logout')).toBe(1);
    const sent = JSON.parse(r.fake.fetchLog.find((c) => c.url.endsWith('/logout'))!.body!).refresh_token;
    expect(sent).toBe(refreshBody.r);
    await expect(r.provider.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
    const replay = await fetch(`${normal.url}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: sent }) });
    expect(replay.status).toBe(400); // the service really ended the session
  });

  it('sign-out still signs out locally when the service is unreachable', async () => {
    let down = false;
    const r = rig(normal, {}, { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down && String(input).endsWith('/logout')) throw new TypeError('offline');
      return fetch(input, init);
    }) as typeof fetch });
    await r.provider.signIn();
    down = true;
    await r.provider.signOut();
    expect(r.provider.state()).toBe('signed-out');
  });

  it('signing out while signed out is harmless', async () => {
    const r = rig(normal);
    await r.provider.signOut();
    expect(r.provider.state()).toBe('signed-out');
    expect(r.count('/logout')).toBe(0);
  });

  it('signing out while the popup is open cancels the sign-in', async () => {
    // a popup that just stays open
    let fake!: Fake;
    fake = fakeEnv({ script: async (_p, u) => { await (await fetch(u)).text(); } });
    const a: OAuth2Auth = { method: 'oauth2', tokenService: normal.url };
    const provider = new OAuth2Provider(endpointFor(a), a, fake.env);
    const p = provider.signIn();
    await new Promise((res) => setTimeout(res, 100));
    await provider.signOut();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('state events tell the whole story', async () => {
    const r = rig(normal);
    await r.provider.signIn();
    await r.provider.signOut();
    expect(r.states).toEqual(['pending', 'ready', 'signed-out']);
  });
});
