// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuth2Provider } from '../src/auth/oauth2';
import type { EndpointConfig, OAuth2Auth } from '../src/config';
import { hasIssuer, startIssuer, type Issuer } from './issuer';
import { fakeEnv, memoryStorage, type Fake } from './oauth-env';

const run = hasIssuer ? describe : describe.skip;
const realFetch = globalThis.fetch.bind(globalThis);

let issuer: Issuer;
beforeAll(async () => { if (hasIssuer) issuer = await startIssuer(); }, 30_000);
afterAll(async () => { if (issuer) await issuer.stop(); });

const PAGE = 'http://localhost:5180/app/index.html?tab=1';
const endpoint = (id: string, auth: OAuth2Auth): EndpointConfig => ({ id, url: 'https://copa.example.com', namespace: 'team', auth });

function page(storage = memoryStorage(), href = PAGE, id = 'main', extra: Partial<OAuth2Auth> = {}) {
  const fake: Fake = fakeEnv({ script: () => undefined, storage: { session: storage }, href });
  const auth: OAuth2Auth = { method: 'oauth2', tokenService: issuer.url, ...extra };
  const provider = new OAuth2Provider(endpoint(id, auth), auth, fake.env);
  return { provider, fake, storage };
}

/** The user presses "Sign in" on the service's page; returns where the service sends the browser next. */
async function userSignsIn(loginUrl: string, o: { user?: string; action?: string } = {}): Promise<string> {
  const html = await (await realFetch(loginUrl)).text();
  const loginId = /name="login_id" value="([^"]+)"/.exec(html)![1];
  const user = o.user ?? 'alice';
  const res = await realFetch(`${new URL(loginUrl).origin}/login/submit`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login_id: loginId, user, password: user, action: o.action ?? 'signin' }).toString(),
  });
  expect(res.status).toBe(303);
  return res.headers.get('location')!;
}

const payload = (header: string) => JSON.parse(Buffer.from(header.split('.')[1], 'base64url').toString());

run('redirect flow (no pop-up)', () => {
  it('sends the page to the service with a state, the return address and the challenge', async () => {
    const { provider, fake, storage } = page();
    await provider.signInRedirect();
    expect(provider.state()).toBe('pending');
    expect(fake.navigated).toHaveLength(1);
    const url = new URL(fake.navigated[0]);
    expect(url.origin + url.pathname).toBe(`${issuer.url}/login`);
    expect(url.searchParams.get('mode')).toBe('redirect');
    expect(url.searchParams.get('redirect_uri')).toBe(PAGE);                       // this page, without any fragment
    expect(url.searchParams.get('audience')).toBe('https://copa.example.com');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(url.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the verifier waits in session storage — and appears nowhere in the URL
    const saved = JSON.parse(storage.getItem('copa-widget:oauth2:redirect:main')!);
    expect(fake.navigated[0]).not.toContain(saved.v);
    expect(saved.s).toBe(url.searchParams.get('state'));
  });

  it('completes the sign-in when the user comes back, and removes the code from the address bar', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    expect(back.startsWith(`${PAGE}#`)).toBe(true);
    expect(back).toContain('copa_login_code=');

    // the page loads again at the returned address, with the same session storage
    const second = page(first.storage, back);
    expect(second.provider.state()).toBe('pending');
    expect((await second.provider.getHeader()).startsWith('Bearer ')).toBe(true);
    expect(second.provider.state()).toBe('ready');
    expect(payload(await second.provider.getHeader()).sub).toBe('alice');
    expect(second.fake.replaced).toEqual([PAGE]);                                  // code and state are gone from the URL
    expect(second.storage.getItem('copa-widget:oauth2:redirect:main')).toBeNull(); // so is the stored secret
  });

  it('keeps unrelated fragment parameters', async () => {
    const first = page(memoryStorage(), `${PAGE}`);
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const second = page(first.storage, `${back}&view=settings`);
    await second.provider.getHeader();
    expect(second.fake.replaced).toEqual([`${PAGE}#view=settings`]);
  });

  it('a cancelled sign-in comes back as a quiet cancellation', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0], { action: 'cancel' });
    expect(back).toContain('copa_login_error=cancelled');
    const second = page(first.storage, back);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.provider.state()).toBe('signed-out');
    expect(second.provider.lastError).toMatchObject({ code: 'cancelled' });
    expect(second.fake.replaced).toEqual([PAGE]);
  });

  it('ignores a fragment whose state it never issued, and leaves the address alone', async () => {
    const { provider, fake } = page(memoryStorage(), `${PAGE}#copa_login_code=stolen&state=forged-state-123`);
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.state()).toBe('signed-out');
    expect(fake.fetchLog).toHaveLength(0);
    expect(fake.replaced).toEqual([]);
  });

  it('rejects a returning code with the wrong state even when a sign-in is pending', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const tampered = back.replace(/state=[^&]+/, 'state=attacker-state-12345');
    const second = page(first.storage, tampered);
    await new Promise((r) => setTimeout(r, 30));
    expect(second.provider.state()).toBe('signed-out');
    expect(second.fake.fetchLog).toHaveLength(0);                                   // the code was never redeemed
    expect(first.storage.getItem('copa-widget:oauth2:redirect:main')).not.toBeNull(); // a forged return does not burn the real one
  });

  it('a code that the service refuses ends as a clear failure', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const bad = back.replace(/copa_login_code=[^&]+/, 'copa_login_code=not-a-real-code');
    const second = page(first.storage, bad);
    await new Promise((r) => setTimeout(r, 200));
    expect(second.provider.state()).toBe('signed-out');
    expect(second.provider.lastError).toMatchObject({ code: 'sign-in-failed' });
  });

  it('the code is useless without the stored verifier (another browser cannot redeem it)', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const code = new URLSearchParams(back.split('#')[1]).get('copa_login_code')!;
    const res = await realFetch(`${issuer.url}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login_code: code, verifier: 'x'.repeat(43) }),
    });
    expect(res.status).toBe(400);
  });

  it('a stale pending sign-in (older than ten minutes) is not completed', async () => {
    const first = page();
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const saved = JSON.parse(first.storage.getItem('copa-widget:oauth2:redirect:main')!);
    first.storage.setItem('copa-widget:oauth2:redirect:main', JSON.stringify({ ...saved, t: Date.now() - 11 * 60_000 }));
    const second = page(first.storage, back);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.provider.state()).toBe('signed-out');
    expect(second.provider.lastError).toMatchObject({ code: 'sign-in-failed' });
  });

  it('with two endpoints on one page only the one that started the sign-in consumes the fragment', async () => {
    const storage = memoryStorage();
    const a = page(storage, PAGE, 'alpha');
    await a.provider.signInRedirect();
    const back = await userSignsIn(a.fake.navigated[0]);
    // after the redirect both providers exist on the page; "beta" must not touch the fragment
    const beta = page(storage, back, 'beta');
    await new Promise((r) => setTimeout(r, 30));
    expect(beta.provider.state()).toBe('signed-out');
    expect(beta.fake.replaced).toEqual([]);
    const alpha = page(storage, back, 'alpha');
    await alpha.provider.getHeader();
    expect(alpha.provider.state()).toBe('ready');
  });

  it('needs session storage and says so', async () => {
    const fake = fakeEnv({ script: () => undefined, href: PAGE });
    const auth: OAuth2Auth = { method: 'oauth2', tokenService: issuer.url };
    const provider = new OAuth2Provider(endpoint('main', auth), auth, fake.env);
    await expect(provider.signInRedirect()).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/session storage/) });
    expect(fake.navigated).toHaveLength(0);
  });

  it('flow=redirect makes signIn() use the redirect instead of a pop-up', async () => {
    const { provider, fake } = page(memoryStorage(), PAGE, 'main', { flow: 'redirect' });
    await provider.signIn();
    expect(fake.openCalls).toHaveLength(0);
    expect(fake.navigated).toHaveLength(1);
  });

  it('a restored persisted session and a returning redirect do not interfere', async () => {
    const storage = memoryStorage();
    const first = page(storage, PAGE, 'main', { persist: 'session' });
    await first.provider.signInRedirect();
    const back = await userSignsIn(first.fake.navigated[0]);
    const second = page(storage, back, 'main', { persist: 'session' });
    await second.provider.getHeader();
    expect(second.provider.state()).toBe('ready');
    // and a plain reload afterwards restores via the refresh token
    const third = page(storage, PAGE, 'main', { persist: 'session' });
    await third.provider.getHeader();
    expect(third.provider.state()).toBe('ready');
  });
});
