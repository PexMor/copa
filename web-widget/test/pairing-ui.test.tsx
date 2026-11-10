import { render } from 'preact';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingEnv } from '../src/auth';
import { CopaShare, type CopaHandle } from '../src/ui';
import { hasCopasrv, startCopasrv, STATIC, type Copasrv } from './copasrv';
import { memoryStorage } from './oauth-env';

const run = hasCopasrv ? describe : describe.skip;
const realFetch = globalThis.fetch.bind(globalThis);

let srv: Copasrv;
let shortSrv: Copasrv;
beforeAll(async () => {
  if (!hasCopasrv) return;
  [srv, shortSrv] = await Promise.all([startCopasrv('rate_limit = 5000'), startCopasrv('rate_limit = 5000\ndevice_ttl_secs = 3')]);
}, 30_000);
afterAll(async () => { await Promise.all([srv, shortSrv].filter(Boolean).map((s) => s.stop())); });

let root: HTMLElement;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
afterEach(async () => { render(null, root); await new Promise((r) => setTimeout(r, 40)); root.remove(); });

const q = (sel: string) => root.querySelector(sel) as HTMLElement | null;

interface Mounted { onError: ReturnType<typeof vi.fn>; onAuthChange: ReturnType<typeof vi.fn>; handle: () => CopaHandle; storage: { session: Storage; local: Storage } }

async function mount(server: Copasrv, auth: Record<string, unknown>, storage = { session: memoryStorage(), local: memoryStorage() }): Promise<Mounted> {
  const onError = vi.fn();
  const onAuthChange = vi.fn();
  let handle!: CopaHandle;
  const env: PairingEnv = { fetch: realFetch, crypto: globalThis.crypto, storage: (k) => storage[k], now: () => Date.now(), pollIntervalMs: 40 };
  render(
    <CopaShare
      config={{ version: 1, endpoints: [{ id: 'main', url: server.url, namespace: 'default', auth: { method: 'pairing', protocol: 'spake2', ...auth } }] }}
      authContext={{ pairingEnv: env }}
      onError={onError} onAuthChange={onAuthChange} onReady={(h) => { handle = h; }}
    />, root);
  await vi.waitFor(() => expect(q('[data-role="pair-input"]')).not.toBeNull());
  return { onError, onAuthChange, handle: () => handle, storage };
}

const type = async (value: string) => {
  const input = q('[data-role="pair-input"]') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect((q('[data-action="pair"]') as HTMLButtonElement).disabled).toBe(false));
};
const ready = () => vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull(), { timeout: 8000 });
const states = (m: Mounted) => m.onAuthChange.mock.calls.map((c) => c[0]);

run('pairing in the widget: short code (SPAKE2)', () => {
  it('shows a code field instead of a sign-in button, and nothing is sent before pairing', async () => {
    await mount(srv, {});
    expect(q('[data-action="sign-in"]')).toBeNull();
    expect(q('[data-action="push"]')).toBeNull();
    expect(q('[data-protocol="spake2"]')).not.toBeNull();
    expect((q('[data-action="pair"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pairs with the code from the operator, then the widget works with the device credential', async () => {
    const m = await mount(srv, {});
    const w = await srv.openWindow('rw', 'ui device');
    await type(w.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
    expect(q('[data-role="pair-input"]')).toBeNull();
    expect(states(m)).toEqual(expect.arrayContaining(['signed-out', 'pending', 'ready']));
    expect(m.onError).not.toHaveBeenCalled();

    await m.handle().share('hello from a paired browser');
    const got = await fetch(`${srv.url}/api/clipboard`, { headers: { Authorization: `Bearer ${STATIC}`, 'X-Copa-Namespace': 'default' } });
    expect(await got.text()).toBe('hello from a paired browser');
    expect((await srv.devices()).some((d) => d.name === 'ui device')).toBe(true);
  });

  it('a wrong code is explained without revealing why, and the user can try again', async () => {
    const m = await mount(srv, {});
    const w = await srv.openWindow();
    await type(`${w.window_id}-00000000`.replace('00000000', w.code === '00000000' ? '11111111' : '00000000'));
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-role="pairing-error"]')).not.toBeNull());
    const err = q('[data-role="pairing-error"]')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toMatch(/Pairing failed/);
    expect(err.textContent).not.toContain(w.code);
    expect(q('[data-action="push"]')).toBeNull();
    expect(m.onError).toHaveBeenCalled();

    await type(w.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
  });

  it('a malformed code is rejected locally with a hint', async () => {
    await mount(srv, {});
    await type('hello');
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-role="pairing-error"]')).not.toBeNull());
    expect(q('[data-role="pairing-error"]')!.textContent).toMatch(/exactly as shown/);
  });

  it('before pairing, the host API rejects with a typed error and the prompt shows', async () => {
    const m = await mount(srv, {});
    await expect(m.handle().share('too early')).rejects.toMatchObject({ code: 'not-authenticated' });
    await expect(m.handle().signIn()).rejects.toMatchObject({ code: 'unsupported-method' });
  });
});

run('pairing in the widget: key exchange with operator approval (ECDH)', () => {
  it('shows the fingerprint and a QR code, waits, and completes when the operator approves', async () => {
    const m = await mount(srv, { protocol: 'ecdh' });
    const w = await srv.openWindow('rw', 'ecdh ui');
    await type(w.window_id);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-role="fingerprint"]')).not.toBeNull());
    const fp = q('[data-role="fingerprint"]')!.textContent!;
    expect(fp).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    expect(q('[data-role="waiting-approval"]')).not.toBeNull();
    await vi.waitFor(() => expect(q('[data-role="qr"] svg')).not.toBeNull());   // QR of the public key, generated locally

    const pend = (await srv.pending()).find((p) => p.fingerprint === fp);
    expect(pend, 'the operator sees the very same digits').toBeDefined();
    expect(await srv.decide(pend!.id, 'approve')).toBe(200);
    await ready();
    expect(q('[data-role="fingerprint"]')).toBeNull();
    expect(m.onError).not.toHaveBeenCalled();
  });

  it('Cancel stops waiting, quietly', async () => {
    const m = await mount(srv, { protocol: 'ecdh' });
    const w = await srv.openWindow();
    await type(w.window_id);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-action="cancel-pairing"]')).not.toBeNull());
    (q('[data-action="cancel-pairing"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-role="pairing-error"]')).not.toBeNull());
    expect(q('[data-role="pairing-error"]')!.getAttribute('data-code')).toBe('cancelled');
    expect(q('[data-role="pairing-error"]')!.getAttribute('role')).toBe('status');
    expect(q('[data-role="fingerprint"]')).toBeNull();
    expect(m.onError).not.toHaveBeenCalled();
  });

  it('a rejection by the operator is reported as such', async () => {
    await mount(srv, { protocol: 'ecdh' });
    const w = await srv.openWindow();
    await type(w.window_id);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(q('[data-role="fingerprint"]')).not.toBeNull());
    const fp = q('[data-role="fingerprint"]')!.textContent!;
    await srv.decide((await srv.pending()).find((p) => p.fingerprint === fp)!.id, 'reject');
    await vi.waitFor(() => expect(q('[data-role="pairing-error"]')).not.toBeNull());
    expect(q('[data-role="pairing-error"]')!.textContent).toMatch(/rejected/);
  });
});

run('device lifetime in the widget', () => {
  it('when the credential ends, the widget goes back to pairing and tells the host', async () => {
    const m = await mount(shortSrv, {});
    const w = await shortSrv.openWindow();
    await type(w.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
    // the 3 s credential runs out; the live stream ends with it and the next reconnect notices
    await vi.waitFor(() => expect(q('[data-role="pairing-ended"]')).not.toBeNull(), { timeout: 12_000 });
    expect(q('[data-action="push"]')).toBeNull();
    await vi.waitFor(() => expect(states(m)).toContain('expired'));
    // pairing again works
    const w2 = await shortSrv.openWindow();
    await type(w2.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
  }, 25_000);

  it('a device revoked by the operator is unpaired by its next request', async () => {
    const m = await mount(srv, {});
    const w = await srv.openWindow('rw', 'to be revoked');
    await type(w.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
    const dev = (await srv.devices()).find((d) => d.name === 'to be revoked' && !d.revoked)!;
    expect(await srv.revoke(dev.dev)).toBe(200);
    (q('[data-action="refresh"]') as HTMLButtonElement | null)?.click();      // any request will do
    await m.handle().paste().catch(() => undefined);
    await vi.waitFor(() => expect(q('[data-role="pairing-ended"]')).not.toBeNull(), { timeout: 8000 });
    await vi.waitFor(() => expect(states(m)).toContain('expired'));
    expect(q('[data-action="push"]')).toBeNull();
  });

  it('persist=session keeps the pairing across a reload of the page', async () => {
    const first = await mount(srv, { persist: 'session' });
    const w = await srv.openWindow();
    await type(w.display_code);
    (q('[data-action="pair"]') as HTMLButtonElement).click();
    await ready();
    render(null, root);
    await new Promise((r) => setTimeout(r, 60));
    await (async () => {
      const onError = vi.fn();
      const env: PairingEnv = { fetch: realFetch, crypto: globalThis.crypto, storage: (k) => first.storage[k], now: () => Date.now(), pollIntervalMs: 40 };
      render(<CopaShare config={{ version: 1, endpoints: [{ id: 'main', url: srv.url, namespace: 'default', auth: { method: 'pairing', protocol: 'spake2', persist: 'session' } }] }}
        authContext={{ pairingEnv: env }} onError={onError} />, root);
      await ready();                                              // no pairing form: restored from storage
      expect(q('[data-role="pair-input"]')).toBeNull();
    })();
  });
});
