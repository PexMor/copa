import { render } from 'preact';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuth2Env } from '../src/auth';
import { CopaShare, type CopaHandle } from '../src/ui';
import { hasIssuer, startIssuer, type Issuer } from './issuer';
import { mockServer, settle, type MockServer } from './mockServer';
import { cancelClick, fakeEnv, loginAs, stayOpen, type Fake, type FakeOptions, type PopupScript } from './oauth-env';

const run = hasIssuer ? describe : describe.skip;

let issuer: Issuer;
beforeAll(async () => { if (hasIssuer) issuer = await startIssuer(); }, 30_000);
afterAll(async () => { if (issuer) await issuer.stop(); });

let root: HTMLElement;
let server: MockServer;
beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  server = mockServer();
  server.accept = (t) => t.split('.').length === 3;     // any JWT; the real checks are copasrv's, tested in Rust
  server.tickets = true;
});
afterEach(async () => { render(null, root); await settle(); root.remove(); vi.unstubAllGlobals(); });

const config = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  endpoints: [{ id: 'main', url: 'https://copa.test', namespace: 'team',
    auth: { method: 'oauth2', tokenService: issuer.url, ...extra } }],
});

interface Mounted { fake: Fake; props: { onAuthChange: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> }; handle: () => CopaHandle }

async function mount(script: (f: () => Fake) => PopupScript, over: Partial<FakeOptions> = {}, cfg: Record<string, unknown> = {}): Promise<Mounted> {
  let fake!: Fake;
  fake = fakeEnv({ script: (p, u) => script(() => fake)(p, u), origin: 'http://localhost:5180', ...over });
  const onAuthChange = vi.fn();
  const onError = vi.fn();
  let handle!: CopaHandle;
  render(<CopaShare config={config(cfg)} authContext={{ oauth2Env: fake.env as OAuth2Env }}
    onAuthChange={onAuthChange} onError={onError} onReady={(h) => { handle = h; }} />, root);
  await vi.waitFor(() => expect(root.querySelector('[data-action="sign-in"]')).not.toBeNull());
  return { fake, props: { onAuthChange, onError }, handle: () => handle };
}

const q = (sel: string) => root.querySelector(sel) as HTMLElement | null;
const text = () => root.textContent ?? '';
const click = (sel: string) => q(sel)!.click();

run('sign-in in the widget', () => {
  it('starts signed out with a Sign in button and no sharing controls', async () => {
    await mount((f) => loginAs(f));
    expect(q('[data-role="auth-state"]')!.textContent).toContain('signed-out');
    expect(q('[data-action="push"]')).toBeNull();
    expect(q('[data-action="sign-out"]')).toBeNull();
    expect(server.requests).toHaveLength(0);                  // nothing is sent to copa before signing in
  });

  it('signing in opens the popup, then shows the widget and talks to copa with the issued token', async () => {
    const m = await mount((f) => loginAs(f, { user: 'alice' }));
    click('[data-action="sign-in"]');
    expect(m.fake.openCalls).toHaveLength(1);                  // opened synchronously in the click
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(q('[data-role="auth-state"]')!.textContent).toContain('ready');
    expect(q('[data-action="sign-in"]')).toBeNull();
    expect(q('[data-action="sign-out"]')).not.toBeNull();

    const auth = server.requests.find((r) => r.path === '/api/capabilities')!.auth!;
    expect(auth.startsWith('Bearer ')).toBe(true);
    const claims = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ sub: 'alice', scope: 'copa:team:rw' });
    expect(m.props.onAuthChange.mock.calls.map((c) => c[0])).toEqual(['signed-out', 'pending', 'ready']);
    expect(m.props.onError).not.toHaveBeenCalled();
  });

  it('shows what is happening while the user signs in, and Cancel ends it quietly', async () => {
    const m = await mount(() => stayOpen);
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="waiting"]')).not.toBeNull());
    expect(q('[data-action="sign-in"]')).toBeNull();           // no second sign-in while one is running
    click('[data-action="cancel-sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="sign-in"]')).not.toBeNull());
    expect(q('[data-role="sign-in-error"]')!.getAttribute('data-code')).toBe('cancelled');
    expect(q('[data-role="sign-in-error"]')!.getAttribute('role')).toBe('status');   // not an alarm
    expect(m.props.onError).not.toHaveBeenCalled();
    expect(m.fake.popups[0].closed).toBe(true);
  });

  it('pressing Cancel on the service page is also just a cancellation', async () => {
    const m = await mount((f) => cancelClick(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="sign-in-error"]')).not.toBeNull());
    expect(q('[data-role="sign-in-error"]')!.getAttribute('data-code')).toBe('cancelled');
    expect(m.props.onError).not.toHaveBeenCalled();
    expect(q('[data-action="sign-in"]')!.textContent).toBe('Try again');
  });

  it('explains a blocked popup, offers to try again and to sign in on this page', async () => {
    const m = await mount((f) => loginAs(f), { blocked: true });
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="sign-in-error"]')).not.toBeNull());
    const err = q('[data-role="sign-in-error"]')!;
    expect(err.getAttribute('data-code')).toBe('popup-blocked');
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/pop-ups/i);
    expect(q('[data-action="sign-in"]')!.textContent).toBe('Try again');
    expect(q('[data-action="sign-in-redirect"]')).not.toBeNull();
    expect(m.props.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'popup-blocked' }));

    // the user allows pop-ups and tries again
    m.fake.options.blocked = false;
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(q('[data-role="sign-in-error"]')).toBeNull();
  });

  it('"Sign in on this page" navigates to the service instead of opening a window', async () => {
    const m = await mount((f) => loginAs(f), { blocked: true, storage: { session: (await import('./oauth-env')).memoryStorage() } });
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="sign-in-redirect"]')).not.toBeNull());
    click('[data-action="sign-in-redirect"]');
    await vi.waitFor(() => expect(m.fake.navigated).toHaveLength(1));
    expect(new URL(m.fake.navigated[0]).searchParams.get('mode')).toBe('redirect');
    expect(q('[data-role="waiting"]')).not.toBeNull();
  });

  it('shows why the token service could not be reached', async () => {
    const m = await mount((f) => loginAs(f), {}, { tokenService: 'http://127.0.0.1:1' });
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="sign-in-error"]')).not.toBeNull());
    expect(q('[data-role="sign-in-error"]')!.textContent).toMatch(/discovery/i);
    expect(m.props.onError).toHaveBeenCalled();
  });

  it('Sign out returns to the signed-out view and ends the session at the service', async () => {
    const m = await mount((f) => loginAs(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="sign-out"]')).not.toBeNull());
    click('[data-action="sign-out"]');
    await vi.waitFor(() => expect(q('[data-action="sign-in"]')).not.toBeNull());
    expect(q('[data-action="push"]')).toBeNull();
    expect(q('[data-role="auth-state"]')!.textContent).toContain('signed-out');
    expect(m.fake.fetchLog.some((c) => c.url.endsWith('/logout'))).toBe(true);
    expect(m.props.onAuthChange.mock.calls.map((c) => c[0]).slice(-1)).toEqual(['signed-out']);
  });

  it('can share after signing in, and signing in again after signing out works', async () => {
    const m = await mount((f) => loginAs(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    await m.handle().share('hello with a token');
    expect(server.clipboard).toBe('hello with a token');
    click('[data-action="sign-out"]');
    await vi.waitFor(() => expect(q('[data-action="sign-in"]')).not.toBeNull());
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
  });

  it('the host can drive sign-in through the handle, and sharing before it is rejected with a prompt', async () => {
    const m = await mount((f) => loginAs(f));
    await expect(m.handle().share('too early')).rejects.toMatchObject({ code: 'not-authenticated' });
    await vi.waitFor(() => expect(q('[data-role="sign-in-required"]')).not.toBeNull());
    expect(server.requests).toHaveLength(0);
    await m.handle().signIn();
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(q('[data-role="sign-in-required"]')).toBeNull();
    await m.handle().signOut();
    await vi.waitFor(() => expect(q('[data-action="sign-in"]')).not.toBeNull());
  });

  it('opens the event stream with a ticket, never with the access token', async () => {
    const m = await mount((f) => loginAs(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="live-state"]')?.getAttribute('data-state')).toBe('live'));
    const { FakeWebSocket } = await import('./mockServer');
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get('ticket')).toMatch(/^T/);
    expect(url.searchParams.has('token')).toBe(false);
    void m;
  });

  it('does not offer "Sign in on this page" for errors other than a blocked popup', async () => {
    await mount((f) => cancelClick(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-role="sign-in-error"]')).not.toBeNull());
    expect(q('[data-action="sign-in-redirect"]')).toBeNull();
  });

  it('keeps the text of the page intact: nothing from the service is rendered as markup', async () => {
    await mount((f) => loginAs(f));
    click('[data-action="sign-in"]');
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(text()).not.toMatch(/<script|eyJ/);                 // no markup and no raw token text anywhere in the widget
  });
});
