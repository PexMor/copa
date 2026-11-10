// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type AuthState } from '../src/auth';
import { PairingProvider, parseCode, parseWindowId, type PairingEnv } from '../src/auth/pairing';
import * as pc from '../src/auth/pair-crypto';
import type { EndpointConfig, PairingAuth } from '../src/config';
import { hasCopasrv, startCopasrv, type Copasrv } from './copasrv';
import { memoryStorage } from './oauth-env';

const run = hasCopasrv ? describe : describe.skip;

let srv: Copasrv;        // default settings
let slidingSrv: Copasrv; // renewal on, 3 s device tokens
let shortSrv: Copasrv;   // 2 s device tokens, no renewal
beforeAll(async () => {
  if (!hasCopasrv) return;
  [srv, slidingSrv, shortSrv] = await Promise.all([
    startCopasrv('rate_limit = 5000'),
    startCopasrv('rate_limit = 5000\nsliding_renewal = true\ndevice_ttl_secs = 3'),
    startCopasrv('rate_limit = 5000\ndevice_ttl_secs = 2'),
  ]);
}, 30_000);
afterAll(async () => { await Promise.all([srv, slidingSrv, shortSrv].filter(Boolean).map((s) => s.stop())); });

const realFetch = globalThis.fetch.bind(globalThis);
const endpoint = (server: Copasrv, auth: PairingAuth): EndpointConfig => ({ id: 'main', url: server.url, namespace: 'default', auth });

function provider(server: Copasrv, auth: Partial<PairingAuth> = {}, env: Partial<PairingEnv> = {}) {
  const a: PairingAuth = { method: 'pairing', protocol: 'spake2', ...auth };
  const sent: { path: string; body: string }[] = [];
  const full: PairingEnv = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ path: new URL(String(input)).pathname, body: typeof init?.body === 'string' ? init.body : '' });
      return realFetch(input, init);
    }) as typeof fetch,
    crypto: globalThis.crypto,
    storage: () => null,
    now: () => Date.now(),
    pollIntervalMs: 40,
    ...env,
  };
  const p = new PairingProvider(endpoint(server, a), a, full);
  const states: AuthState[] = [];
  p.onChange((s) => states.push(s));
  return { p, sent, states, ep: endpoint(server, a) };
}

const token = async (p: PairingProvider) => (await p.getHeader()).replace('Bearer ', '');

run('input parsing', () => {
  it('accepts the code in the forms people type it', () => {
    for (const s of ['K7QF2M-48217730', 'k7qf2m 4821 7730', ' K7QF2M48217730 ', 'K7QF-2M48-2177-30']) {
      expect(parseCode(s), s).toEqual({ id: 'K7QF2M', code: '48217730' });
    }
    for (const bad of ['', 'K7QF2M', 'K7QF2M-4821773', 'K7QF2M-482177300', 'K7QF2-48217730', 'K7QF2M-4821773a']) expect(parseCode(bad), bad).toBeNull();
    expect(parseWindowId('K7QF2M')).toBe('K7QF2M');
    expect(parseWindowId('k7qf2m-48217730')).toBe('K7QF2M');
    expect(parseWindowId('K7Q')).toBeNull();
  });
});

run('SPAKE2 pairing against the real server (cross-implementation)', () => {
  it('the JavaScript client and the Rust server derive the same key and issue a credential', async () => {
    const w = await srv.openWindow('rw', 'laptop');
    const { p, states } = provider(srv);
    const attempt = await p.beginPairing(w.display_code);
    expect(attempt.fingerprint).toBeUndefined();
    await attempt.done;
    expect(p.state()).toBe('ready');
    expect(states).toEqual(['pending', 'ready']);
    const t = await token(p);
    expect(t.startsWith('v1.')).toBe(true);
    expect(await srv.clipboard(t)).toBe(200);
    expect(await srv.clipboard(t, 'POST', 'from the js client')).toBe(200);
    expect((await srv.devices()).some((d) => d.name === 'laptop' && d.acc === 'rw')).toBe(true);
  });

  it('honours the access level of the window', async () => {
    const w = await srv.openWindow('r', 'reader');
    const { p } = provider(srv);
    await (await p.beginPairing(w.display_code)).done;
    const t = await token(p);
    expect(await srv.clipboard(t)).toBe(200);
    expect(await srv.clipboard(t, 'POST', 'x')).toBe(401);
  });

  it('sends the device name when given', async () => {
    const w = await srv.openWindow('rw', 'default label');
    const { p } = provider(srv);
    await (await p.beginPairing(w.display_code, 'Pixel 9')).done;
    expect((await srv.devices()).some((d) => d.name === 'Pixel 9')).toBe(true);
  });

  it('never sends the code (or anything derived from it but the SPAKE2 message and confirmation)', async () => {
    const w = await srv.openWindow();
    const { p, sent } = provider(srv);
    await (await p.beginPairing(w.display_code)).done;
    expect(sent.map((s) => s.path)).toEqual(['/api/pair/spake2/start', '/api/pair/spake2/confirm']);
    for (const s of sent) expect(s.body).not.toContain(w.code);
    expect(Object.keys(JSON.parse(sent[0].body)).sort()).toEqual(['msg', 'window_id']);
    expect(Object.keys(JSON.parse(sent[1].body)).sort()).toEqual(['mac', 'session_id']);
  });

  it('a wrong code fails with a generic message and gives no credential', async () => {
    const w = await srv.openWindow();
    const { p, states } = provider(srv);
    const wrong = `${w.window_id}-${w.code === '00000000' ? '11111111' : '00000000'}`;
    const attempt = await p.beginPairing(wrong);
    await expect(attempt.done).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/Pairing failed/) });
    expect(p.state()).toBe('signed-out');
    expect(states).toEqual(['pending', 'signed-out']);
    await expect(p.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });

  it('an unknown window looks exactly like a wrong code', async () => {
    const a = provider(srv);
    const failure = async (input: string) => {
      const at = await a.p.beginPairing(input);
      return at.done.then(() => 'paired', (e: Error) => e.message);
    };
    const w = await srv.openWindow();
    const unknown = await failure('ZZZZZZ-12345678');
    const wrong = await failure(`${w.window_id}-${w.code === '12345678' ? '87654321' : '12345678'}`);
    expect(unknown).toBe(wrong);
  });

  it('rejects malformed input before sending anything', async () => {
    const { p, sent } = provider(srv);
    await expect(p.beginPairing('nope')).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/exactly as shown/) });
    expect(sent).toHaveLength(0);
    expect(p.state()).toBe('signed-out');
  });

  it('a code works once: the window is used up', async () => {
    const w = await srv.openWindow();
    const first = provider(srv);
    await (await first.p.beginPairing(w.display_code)).done;
    const second = provider(srv);
    await expect((await second.p.beginPairing(w.display_code)).done).rejects.toMatchObject({ code: 'sign-in-failed' });
  });

  it('five wrong codes close the window, even for the right code', async () => {
    const w = await srv.openWindow();
    const wrong = w.code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) {
      const { p } = provider(srv);
      await expect((await p.beginPairing(`${w.window_id}-${wrong}`)).done).rejects.toBeDefined();
    }
    const { p } = provider(srv);
    await expect((await p.beginPairing(w.display_code)).done).rejects.toMatchObject({ code: 'sign-in-failed' });
  }, 20_000);

  it('refuses a server that does not know the code (the confirmation does not verify)', async () => {
    // a man in the middle that answers the SPAKE2 start itself, with a password of its own choosing
    const w = await srv.openWindow();
    const evil = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/spake2/start')) {
        const req = JSON.parse(String(init?.body));
        const mine = pc.spake2Start(new TextEncoder().encode('00000000'));
        void req;
        return new Response(JSON.stringify({ session_id: 'x', msg: pc.b64u(new Uint8Array([0x42, ...mine.msg.slice(1)])) }));
      }
      if (url.endsWith('/spake2/confirm')) return new Response(JSON.stringify({ mac: pc.b64u(new Uint8Array(32)), sealed: pc.b64u(new Uint8Array(64)) }));
      return realFetch(input, init);
    };
    const { p } = provider(srv, {}, { fetch: evil as typeof fetch });
    await expect((await p.beginPairing(w.display_code)).done).rejects.toMatchObject({ code: 'sign-in-failed', message: expect.stringMatching(/did not prove/) });
    expect(p.state()).toBe('signed-out');
  });

  it('a tampered sealed credential is refused', async () => {
    const w = await srv.openWindow();
    const tamper = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (!String(input).endsWith('/spake2/confirm') || res.status !== 200) return res;
      const v = await res.json();
      const sealed = pc.unb64u(v.sealed);
      sealed[sealed.length - 1] ^= 1;
      return new Response(JSON.stringify({ ...v, sealed: pc.b64u(sealed) }));
    };
    const { p } = provider(srv, {}, { fetch: tamper as typeof fetch });
    await expect((await p.beginPairing(w.display_code)).done).rejects.toMatchObject({ message: expect.stringMatching(/decrypted/) });
    expect(p.state()).toBe('signed-out');
  });
});

run('ECDH pairing against the real server', () => {
  it('shows a fingerprint equal to the operator’s, and completes once approved', async () => {
    const w = await srv.openWindow('rw', 'ecdh device');
    const { p, states } = provider(srv, { protocol: 'ecdh' });
    const attempt = await p.beginPairing(w.window_id);
    expect(attempt.fingerprint).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);

    const pend = (await srv.pending()).find((x) => x.fingerprint === attempt.fingerprint);
    expect(pend, 'the operator sees the same fingerprint').toBeDefined();
    await new Promise((r) => setTimeout(r, 120));
    expect(p.state()).toBe('pending');
    expect(await srv.decide(pend!.id, 'approve')).toBe(200);
    await attempt.done;
    expect(p.state()).toBe('ready');
    expect(states).toEqual(['pending', 'ready']);
    expect(await srv.clipboard(await token(p), 'POST', 'via ecdh')).toBe(200);
  });

  it('accepts the full code and uses only the window id', async () => {
    const w = await srv.openWindow();
    const { p } = provider(srv, { protocol: 'ecdh' });
    const attempt = await p.beginPairing(w.display_code.toLowerCase());
    const pend = (await srv.pending()).find((x) => x.fingerprint === attempt.fingerprint)!;
    await srv.decide(pend.id, 'approve');
    await attempt.done;
    expect(p.state()).toBe('ready');
  });

  it('a rejection ends as a cancellation', async () => {
    const w = await srv.openWindow();
    const { p } = provider(srv, { protocol: 'ecdh' });
    const attempt = await p.beginPairing(w.window_id);
    const pend = (await srv.pending()).find((x) => x.fingerprint === attempt.fingerprint)!;
    await srv.decide(pend.id, 'reject');
    await expect(attempt.done).rejects.toMatchObject({ code: 'cancelled', message: expect.stringMatching(/rejected/) });
    expect(p.state()).toBe('signed-out');
  });

  it('can be cancelled by the user while waiting', async () => {
    const w = await srv.openWindow();
    const { p } = provider(srv, { protocol: 'ecdh' });
    const attempt = await p.beginPairing(w.window_id);
    setTimeout(() => attempt.cancel(), 100);
    await expect(attempt.done).rejects.toMatchObject({ code: 'cancelled' });
    expect(p.state()).toBe('signed-out');
  });

  it('an unknown window fails right away', async () => {
    const { p } = provider(srv, { protocol: 'ecdh' });
    await expect(p.beginPairing('ZZZZZZ')).rejects.toMatchObject({ code: 'sign-in-failed' });
    expect(p.state()).toBe('signed-out');
  });

  it('the fingerprint differs when a different party answers (man in the middle)', async () => {
    const w = await srv.openWindow();
    // the attacker answers the device with its own key, and talks to the server with another
    const attackerKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const attackerPub = new Uint8Array(await crypto.subtle.exportKey('raw', attackerKey.publicKey));
    const mitm = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (!String(input).endsWith('/ecdh/start') || res.status !== 200) return res;
      const v = await res.json();
      return new Response(JSON.stringify({ ...v, pub: pc.b64u(attackerPub) }));
    };
    const { p } = provider(srv, { protocol: 'ecdh' }, { fetch: mitm as typeof fetch });
    const attempt = await p.beginPairing(w.window_id);
    const outcome = attempt.done.then(() => null, (e: Error) => e);
    const operatorSees = (await srv.pending()).map((x) => x.fingerprint);
    expect(operatorSees).not.toContain(attempt.fingerprint);
    // and the device cannot complete: the confirmation will never verify
    const pend = (await srv.pending())[0];
    await srv.decide(pend.id, 'approve');
    expect(await outcome).toMatchObject({ code: 'sign-in-failed' });
    expect(p.state()).toBe('signed-out');
  });
});

run('credential lifetime', () => {
  it('expires: the device returns to the unpaired state and says so', async () => {
    const w = await shortSrv.openWindow();
    const { p, states } = provider(shortSrv);
    await (await p.beginPairing(w.display_code)).done;
    expect(await shortSrv.clipboard(await token(p))).toBe(200);
    await new Promise((r) => setTimeout(r, 2200));
    expect(p.state()).toBe('expired');
    expect(states).toEqual(['pending', 'ready', 'expired']);
    await expect(p.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });

  it('a revocation by the operator is noticed on the next request and unpairs the device', async () => {
    const w = await srv.openWindow();
    const { p, ep, states } = provider(srv);
    await (await p.beginPairing(w.display_code)).done;
    const dev = (await srv.devices()).find((d) => !d.revoked && d.name === 'test device')!;
    const api = createApi(ep, p);
    expect(await api.history()).toBeDefined();
    expect(await srv.revoke(dev.dev)).toBe(200);
    await expect(api.history()).rejects.toMatchObject({ status: 401 });
    expect(p.state()).toBe('expired');
    expect(states[states.length - 1]).toBe('expired');
    // and pairing again works
    const w2 = await srv.openWindow();
    await (await p.beginPairing(w2.display_code)).done;
    expect(p.state()).toBe('ready');
  });

  it('renews while valid when the server allows sliding renewal', async () => {
    const w = await slidingSrv.openWindow();
    const { p } = provider(slidingSrv);
    await (await p.beginPairing(w.display_code)).done;
    const first = await token(p);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await p.renew()).toBe(true);
    const second = await token(p);
    expect(second).not.toBe(first);
    await new Promise((r) => setTimeout(r, 2000)); // the first token would be gone by now
    expect(await slidingSrv.clipboard(first)).toBe(401);
    expect(await slidingSrv.clipboard(second)).toBe(200);
    expect(p.state()).toBe('ready');
  }, 15_000);

  it('without renewal a proactive renew keeps the credential until it ends', async () => {
    const w = await srv.openWindow();
    const { p } = provider(srv);
    await (await p.beginPairing(w.display_code)).done;
    const t = await token(p);
    expect(await p.renew()).toBe(false);
    expect(p.state()).toBe('ready');
    expect(await token(p)).toBe(t);
  });

  it('signing out forgets the credential (the server-side device record stays until revoked)', async () => {
    const w = await srv.openWindow();
    const { p } = provider(srv);
    await (await p.beginPairing(w.display_code)).done;
    await p.signOut();
    expect(p.state()).toBe('signed-out');
    await expect(p.getHeader()).rejects.toMatchObject({ code: 'not-authenticated' });
  });
});

run('persistence', () => {
  it('memory by default: a reload means pairing again', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    const w = await srv.openWindow();
    const a = provider(srv, {}, { storage: (k) => storage[k] });
    await (await a.p.beginPairing(w.display_code)).done;
    expect(storage.session.length + storage.local.length).toBe(0);
    expect(provider(srv, {}, { storage: (k) => storage[k] }).p.state()).toBe('signed-out');
  });

  for (const kind of ['session', 'local'] as const) {
    it(`persist=${kind}: the credential survives a reload`, async () => {
      const storage = { session: memoryStorage(), local: memoryStorage() };
      const w = await srv.openWindow();
      const a = provider(srv, { persist: kind }, { storage: (k) => storage[k] });
      await (await a.p.beginPairing(w.display_code)).done;
      const t = await token(a.p);
      expect(storage[kind].getItem('copa-widget:pairing:main')).toContain(t.slice(0, 20));
      const b = provider(srv, { persist: kind }, { storage: (k) => storage[k] });
      expect(b.p.state()).toBe('ready');
      expect(await token(b.p)).toBe(t);
      await b.p.signOut();
      expect(storage[kind].getItem('copa-widget:pairing:main')).toBeNull();
    });
  }

  it('an expired stored credential is dropped', async () => {
    const storage = { session: memoryStorage(), local: memoryStorage() };
    storage.local.setItem('copa-widget:pairing:main', JSON.stringify({ t: 'v1.a.b', e: Date.now() - 1000 }));
    const { p } = provider(srv, { persist: 'local' }, { storage: (k) => storage[k] });
    expect(p.state()).toBe('signed-out');
    expect(storage.local.getItem('copa-widget:pairing:main')).toBeNull();
    for (const bad of ['junk', '{}', '{"t":5}']) {
      storage.local.setItem('copa-widget:pairing:main', bad);
      expect(provider(srv, { persist: 'local' }, { storage: (k) => storage[k] }).p.state()).toBe('signed-out');
    }
  });
});

run('key schedule parity', () => {
  it('fingerprint test vector equals the server’s', () => {
    const t = new Uint8Array(32);
    new DataView(t.buffer).setBigUint64(0, 1_234_567_890_123_456_789n);
    expect(pc.fingerprint(t)).toBe('4567 8901 2345 6789'); // the same vector as pair_crypto.rs: 1234567890123456789 mod 10^16
  });
});
