// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CopaAuthError } from '../src/auth';
import { OAuth2Provider } from '../src/auth/oauth2';
import type { EndpointConfig, OAuth2Auth } from '../src/config';
import { hasIssuer, startIssuer, type Issuer } from './issuer';
import { cancelClick, closeWithoutLogin, fakeEnv, loginAs, stayOpen, type Fake, type FakeOptions } from './oauth-env';

const run = hasIssuer ? describe : describe.skip;

let issuer: Issuer;
beforeAll(async () => { if (hasIssuer) issuer = await startIssuer(); }, 30_000);
afterAll(async () => { if (issuer) await issuer.stop(); });

const endpointFor = (auth: OAuth2Auth): EndpointConfig =>
  ({ id: 'main', url: 'https://copa.example.com', namespace: 'team', auth });

/** A provider wired to a fake browser whose popups run `script`. */
function setup(script: (fake: () => Fake) => ReturnType<typeof loginAs>, over: Partial<FakeOptions> = {}, auth: Partial<OAuth2Auth> = {}) {
  let fake!: Fake;
  fake = fakeEnv({ script: (p, u) => script(() => fake)(p, u), ...over });
  const a: OAuth2Auth = { method: 'oauth2', tokenService: issuer.url, ...auth };
  const provider = new OAuth2Provider(endpointFor(a), a, fake.env);
  return { provider, fake };
}

const payload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const accessToken = async (p: OAuth2Provider) => (await p.getHeader()).replace('Bearer ', '');

run('OAuth2 popup sign-in against the token issuer', () => {
  it('opens the popup synchronously from the click, before anything is awaited', () => {
    const { provider, fake } = setup((f) => loginAs(f));
    const p = provider.signIn();           // no await: the popup must already be open
    expect(fake.openCalls).toHaveLength(1);
    expect(fake.openCalls[0].url).toBe('about:blank');
    expect(fake.openCalls[0].features).toContain('width=480');
    return p;
  });

  it('signs in through the popup, redeems the code with its verifier and holds a usable token', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { user: 'alice' }));
    const states: string[] = [];
    provider.onChange((s) => states.push(s));
    expect(provider.state()).toBe('signed-out');
    await provider.signIn();
    expect(provider.state()).toBe('ready');
    expect(states).toEqual(['pending', 'ready']);

    const claims = payload(await accessToken(provider));
    expect(claims).toMatchObject({ sub: 'alice', scope: 'copa:team:rw', aud: 'https://copa.example.com', iss: issuer.url });
    expect(fake.popups[0].closed).toBe(true);

    // what was sent to the sign-in page: audience (default = the endpoint's origin), origin, S256 challenge
    const login = fake.popups[0].loginUrl!;
    expect(login.origin + login.pathname).toBe(`${issuer.url}/login`);
    expect(login.searchParams.get('audience')).toBe('https://copa.example.com');
    expect(login.searchParams.get('origin')).toBe('http://localhost:5180');
    expect(login.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('keeps the verifier secret: only its challenge appears in the sign-in URL', async () => {
    const { provider, fake } = setup((f) => loginAs(f));
    await provider.signIn();
    const tokenCall = fake.fetchLog.find((c) => c.url.endsWith('/token'))!;
    const verifier = JSON.parse(tokenCall.body!).verifier as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.popups[0].history.join(' ')).not.toContain(verifier);
    expect(fake.fetchLog.filter((c) => !c.url.endsWith('/token') && !c.url.endsWith('/poll')).map((c) => c.body ?? '').join(' ')).not.toContain(verifier);
  });

  it('never puts a token in a URL', async () => {
    const { provider, fake } = setup((f) => loginAs(f));
    await provider.signIn();
    const access = await accessToken(provider);
    for (const c of fake.fetchLog) expect(c.url).not.toContain(access);
    for (const p of fake.popups) expect(p.history.join(' ')).not.toContain(access);
  });

  it('uses an explicit audience when configured', async () => {
    const { provider, fake } = setup((f) => loginAs(f), {}, { audience: 'https://other.example' });
    await provider.signIn();
    expect(fake.popups[0].loginUrl!.searchParams.get('audience')).toBe('https://other.example');
    expect(payload(await accessToken(provider)).aud).toBe('https://other.example');
  });

  it('honours the configured popup size', async () => {
    const { provider, fake } = setup((f) => loginAs(f), {}, { popup: { width: 520, height: 700 } });
    await provider.signIn();
    expect(fake.openCalls[0].features).toContain('width=520');
    expect(fake.openCalls[0].features).toContain('height=700');
  });

  it('works with explicit endpoint URLs instead of discovery', async () => {
    const { provider, fake } = setup((f) => loginAs(f), {}, {
      tokenService: undefined, loginUrl: `${issuer.url}/login`, pollUrl: `${issuer.url}/poll`, tokenUrl: `${issuer.url}/token`,
      refreshUrl: `${issuer.url}/refresh`, logoutUrl: `${issuer.url}/logout`,
    });
    await provider.signIn();
    expect(provider.state()).toBe('ready');
    expect(fake.fetchLog.some((c) => c.url.includes('.well-known'))).toBe(false);
  });

  it('shares one popup between concurrent sign-in calls', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { delayMs: 50 }));
    const a = provider.signIn();
    const b = provider.signIn();
    await Promise.all([a, b]);
    expect(fake.openCalls).toHaveLength(1);
  });

  it('signs in different users', async () => {
    for (const [user, scope] of [['bob', 'copa:team:r'], ['carol', '']] as const) {
      const { provider } = setup((f) => loginAs(f, { user }));
      await provider.signIn();
      expect(payload(await accessToken(provider))).toMatchObject({ sub: user, scope });
    }
  });

  // ── hand-off safety ─────────────────────────────────────────────────────────

  it('ignores messages from other origins and other windows', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { delayMs: 150 }));
    const p = provider.signIn();
    await new Promise((r) => setTimeout(r, 40));
    // a hostile page / another window tries to inject a code
    fake.emit({ origin: 'https://evil.example', source: fake.popups[0], data: { type: 'copa-login', login_code: 'stolen' } });
    fake.emit({ origin: issuer.origin, source: {}, data: { type: 'copa-login', login_code: 'stolen' } });
    await p;                                   // the real login still completes, with the real code
    expect(provider.state()).toBe('ready');
    expect(fake.fetchLog.filter((c) => c.url.endsWith('/token') && c.body?.includes('stolen'))).toHaveLength(0);
  });

  it('ignores malformed messages', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { delayMs: 100 }));
    const p = provider.signIn();
    await new Promise((r) => setTimeout(r, 30));
    for (const data of [null, 'copa-login', 5, {}, { type: 'copa-login' }, { type: 'copa-login', login_code: 5 }]) {
      fake.emit({ origin: issuer.origin, source: fake.popups[0], data });
    }
    await p;
    expect(provider.state()).toBe('ready');
  });

  // ── ending without a token ──────────────────────────────────────────────────

  it('reports a cancellation when the user presses Cancel', async () => {
    const { provider, fake } = setup((f) => cancelClick(f));
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'cancelled' });
    expect(provider.state()).toBe('signed-out');
    expect(fake.popups[0].closed).toBe(true);
  });

  it('reports a cancellation when the user closes the window', async () => {
    const { provider } = setup(() => closeWithoutLogin);
    const t = Date.now();
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'cancelled' });
    expect(Date.now() - t).toBeGreaterThanOrEqual(150); // waited the grace period, polling for a late result
    expect(provider.state()).toBe('signed-out');
  });

  it('tells the user when the browser blocks the popup, and sends nothing', async () => {
    const { provider, fake } = setup((f) => loginAs(f), { blocked: true });
    const err = await provider.signIn().catch((e) => e);
    expect(err).toBeInstanceOf(CopaAuthError);
    expect(err.code).toBe('popup-blocked');
    expect(err.message).toMatch(/pop-ups/i);
    expect(provider.state()).toBe('signed-out');
    expect(fake.fetchLog).toHaveLength(0);
    // and the user can simply try again
    const retry = setup((f) => loginAs(f));
    await retry.provider.signIn();
    expect(retry.provider.state()).toBe('ready');
  });

  it('can be cancelled by the host while it waits for the user', async () => {
    const { provider, fake } = setup(() => stayOpen);
    const p = provider.signIn();
    await new Promise((r) => setTimeout(r, 80));
    provider.cancelSignIn();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.popups[0].closed).toBe(true);
    expect(provider.state()).toBe('signed-out');
  });

  it('gives up after the login timeout', async () => {
    const { provider } = setup(() => stayOpen, { loginTimeoutMs: 150 });
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/timed out/) });
    expect(provider.state()).toBe('signed-out');
  });

  it('fails clearly when the token service cannot be reached', async () => {
    const { provider, fake } = setup((f) => loginAs(f), {}, { tokenService: 'http://127.0.0.1:1' });
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/discovery/) });
    expect(fake.popups[0].closed).toBe(true);
    expect(provider.state()).toBe('signed-out');
  });

  it('refuses a discovery document that points at insecure URLs', async () => {
    const evil = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('.well-known')
        ? new Response(JSON.stringify({ login_url: 'http://evil.example/login', token_url: `${issuer.url}/token`, refresh_url: `${issuer.url}/refresh`, logout_url: `${issuer.url}/logout` }))
        : fetch(input, init);
    const { provider } = setup((f) => loginAs(f), { fetch: evil as typeof fetch });
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/https/) });
  });

  it('refuses a discovery document with missing endpoints', async () => {
    const partial = async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('.well-known') ? new Response(JSON.stringify({ login_url: `${issuer.url}/login` })) : fetch(input, init);
    const { provider } = setup((f) => loginAs(f), { fetch: partial as typeof fetch });
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/token_url/) });
  });

  it('getHeader() while signed out is a typed error', async () => {
    const { provider } = setup((f) => loginAs(f));
    await expect(provider.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });

  // ── opener severed (COOP) ───────────────────────────────────────────────────

  it('completes through polling when the provider cut window.opener', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { deliver: false, detached: true }));
    await provider.signIn();                   // no message ever arrives, popup.closed reads true
    expect(provider.state()).toBe('ready');
    expect(fake.fetchLog.some((c) => c.url.endsWith('/poll'))).toBe(true);
    expect(payload(await accessToken(provider)).sub).toBe('alice');
  });

  it('a detached popup that reports closed is not mistaken for a cancellation, even for a slow user', async () => {
    const { provider } = setup((f) => loginAs(f, { deliver: false, detached: true, delayMs: 500 }), { closedGraceMs: 100 });
    await provider.signIn();                   // closed=true for 500 ms > grace, yet the login completes
    expect(provider.state()).toBe('ready');
  });

  it('a closed popup that never reported itself detached means "cancelled", once the grace period is over', async () => {
    // closed immediately (the user closed it), then — too late — the login page is still answered
    const late = (f: () => Fake): ReturnType<typeof loginAs> => async (popup, url) => {
      popup.closed = true;
      await loginAs(f, { deliver: false, detached: false, closeAfter: false, delayMs: 700 })(popup, url);
    };
    const { provider } = setup(late, { closedGraceMs: 100 });
    await expect(provider.signIn()).rejects.toMatchObject({ code: 'cancelled' });
    expect(provider.state()).toBe('signed-out');
  });

  it('polling only asks for the login with its own verifier', async () => {
    const { provider, fake } = setup((f) => loginAs(f, { deliver: false, detached: true }));
    await provider.signIn();
    const polls = fake.fetchLog.filter((c) => c.url.endsWith('/poll'));
    expect(polls.length).toBeGreaterThan(0);
    for (const p of polls) expect(Object.keys(JSON.parse(p.body!))).toEqual(['verifier']);
  });
});
