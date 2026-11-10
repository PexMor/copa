import type { EndpointConfig, PairingAuth } from '../config';
import { StateEmitter } from './emitter';
import {
  b64u, deriveKeys, fingerprint as fingerprintOf, mac, macEqual, open, spake2Start, transcript, unb64u,
} from './pair-crypto';
import { CopaAuthError, type AuthProvider, type AuthState } from './types';

export interface PairingEnv {
  fetch: typeof fetch;
  crypto: Crypto;
  storage(kind: 'session' | 'local'): Storage | null;
  now(): number;
  /** How often an ECDH pairing asks whether the operator has decided. */
  pollIntervalMs: number;
}

export function pairingBrowserEnv(): PairingEnv {
  return {
    fetch: (...a) => fetch(...a),
    crypto: globalThis.crypto,
    storage: (kind) => {
      try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch { return null; }
    },
    now: () => Date.now(),
    pollIntervalMs: 2000,
  };
}

/** A pairing in progress. */
export interface PairingAttempt {
  /** ECDH only: the digits to compare with the operator's screen. */
  fingerprint?: string;
  /** ECDH only: this device's public key (base64url) — shown as a QR code the operator can scan to approve. */
  publicKey?: string;
  /** Resolves when the device holds a credential; rejects with a CopaAuthError otherwise. */
  done: Promise<void>;
  cancel(): void;
}

export interface PairingCapable {
  readonly protocol: 'spake2' | 'ecdh';
  beginPairing(input: string, deviceName?: string): Promise<PairingAttempt>;
}

interface Credential {
  token: string;
  expiresAt: number;
}

const STORAGE_PREFIX = 'copa-widget:pairing:';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
/** Try to renew once less than this fraction of the lifetime is left (only works if the server allows it). */
const FAILED = 'Pairing failed. Check the code and try again — the pairing window may have expired or been used up.';

export const parseCode = (input: string): { id: string; code: string } | null => {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{6}\d{8}$/.test(s) ? { id: s.slice(0, 6), code: s.slice(6) } : null;
};

export const parseWindowId = (input: string): string | null => {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{6}(\d{8})?$/.test(s) ? s.slice(0, 6) : null;
};

/**
 * Device pairing: the credential is issued by copasrv itself after a SPAKE2 exchange on a short
 * code, or after an operator confirms an ECDH fingerprint. The credential is time-limited and
 * revocable; when it ends the provider goes back to `expired` so the UI can offer pairing again.
 */
export class PairingProvider implements AuthProvider, PairingCapable {
  readonly method = 'pairing' as const;
  readonly protocol: 'spake2' | 'ecdh';

  private readonly emitter = new StateEmitter('signed-out');
  private cred: Credential | null = null;
  private renewing: Promise<boolean> | null = null;
  private attempt: { cancel(): void } | null = null;
  lastError: CopaAuthError | null = null;

  constructor(
    private readonly endpoint: EndpointConfig,
    private readonly auth: PairingAuth,
    private readonly env: PairingEnv = pairingBrowserEnv(),
  ) {
    this.protocol = auth.protocol;
    this.restore();
  }

  state(): AuthState {
    // the credential may have expired since the last look
    if (this.cred && this.cred.expiresAt <= this.env.now()) this.drop('expired');
    return this.emitter.state;
  }

  onChange(cb: (state: AuthState) => void): () => void { return this.emitter.subscribe(cb); }

  // ── credential ───────────────────────────────────────────────────────────────

  private key(): string { return STORAGE_PREFIX + this.endpoint.id; }

  private store(): Storage | null {
    const p = this.auth.persist;
    return p === 'session' || p === 'local' ? this.env.storage(p) : null;
  }

  private save(): void {
    const st = this.store();
    if (!st) return;
    try {
      if (this.cred) st.setItem(this.key(), JSON.stringify({ t: this.cred.token, e: this.cred.expiresAt }));
      else st.removeItem(this.key());
    } catch { /* the pairing just will not survive a reload */ }
  }

  private restore(): void {
    const st = this.store();
    if (!st) return;
    try {
      const raw = st.getItem(this.key());
      const v = raw ? JSON.parse(raw) as { t?: unknown; e?: unknown } : null;
      if (v && typeof v.t === 'string' && typeof v.e === 'number' && v.e > this.env.now()) {
        this.cred = { token: v.t, expiresAt: v.e };
        this.emitter.set('ready');
      } else if (raw) st.removeItem(this.key());
    } catch { /* ignore */ }
  }

  private setCredential(c: Credential): void {
    this.cred = c;
    this.save();
    this.lastError = null;
    this.emitter.set('ready');
  }

  private drop(state: AuthState): void {
    this.cred = null;
    this.save();
    this.emitter.set(state);
  }

  async getHeader(): Promise<string> {
    if (this.state() !== 'ready' || !this.cred) throw new CopaAuthError('not-authenticated', 'This device is not paired');
    return `Bearer ${this.cred.token}`;
  }

  /**
   * The hook CopaApi calls after the server answered 401 to this device's credential: it is no
   * longer accepted (revoked, expired, unknown). Try to renew it; if that is not possible the
   * device is unpaired so the UI can offer pairing again.
   */
  refresh(): Promise<boolean> {
    this.renewing ??= this.doRenew(true).finally(() => { this.renewing = null; });
    return this.renewing;
  }

  /** Buy a fresh credential before the current one ends (needs `sliding_renewal` on the server). */
  renew(): Promise<boolean> {
    this.renewing ??= this.doRenew(false).finally(() => { this.renewing = null; });
    return this.renewing;
  }

  private async doRenew(rejected: boolean): Promise<boolean> {
    const c = this.cred;
    if (!c) return false;
    if (c.expiresAt <= this.env.now()) { this.drop('expired'); return false; }
    let res: Response;
    try {
      res = await this.env.fetch(`${this.endpoint.url}/api/pair/renew`, {
        method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${c.token}`, 'X-Copa-Namespace': this.endpoint.namespace },
      });
    } catch { return false; }                       // offline: keep what we have
    if (res.status === 401) { this.drop('expired'); return false; } // revoked (or expired): back to unpaired
    if (!res.ok) {
      // 404: the server does not renew. If the server just rejected the credential, that is the end of it.
      if (rejected) this.drop('expired');
      return false;
    }
    try {
      const v = await res.json() as { token?: unknown; expires_at?: unknown };
      if (typeof v.token !== 'string' || typeof v.expires_at !== 'number') return false;
      this.setCredential({ token: v.token, expiresAt: v.expires_at });
      return true;
    } catch { return false; }
  }

  async signOut(): Promise<void> {
    this.attempt?.cancel();
    this.drop('signed-out');
  }

  // ── pairing ──────────────────────────────────────────────────────────────────

  private fail(code: ConstructorParameters<typeof CopaAuthError>[0], message: string): CopaAuthError {
    this.lastError = new CopaAuthError(code, message);
    return this.lastError;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.env.fetch(`${this.endpoint.url}${path}`, { method: 'POST', credentials: 'omit', headers: JSON_HEADERS, body: JSON.stringify(body) });
    } catch (e) {
      throw this.fail('sign-in-failed', `Cannot reach the server (${e instanceof Error ? e.message : String(e)})`);
    }
    let json: Record<string, unknown> = {};
    try { json = await res.json() as Record<string, unknown>; } catch { /* not JSON */ }
    if (res.status === 429) throw this.fail('sign-in-failed', 'Too many attempts. Wait a few seconds and try again.');
    return { status: res.status, json };
  }

  async beginPairing(input: string, deviceName?: string): Promise<PairingAttempt> {
    this.lastError = null;
    if (this.protocol === 'spake2') {
      const parsed = parseCode(input);
      if (!parsed) throw this.fail('sign-in-failed', 'Enter the code exactly as shown, for example K7QF2M-48217730.');
      return this.spake2(parsed.id, parsed.code, deviceName);
    }
    const id = parseWindowId(input);
    if (!id) throw this.fail('sign-in-failed', 'Enter the pairing code shown by the operator (the first six characters are enough).');
    return this.ecdh(id, deviceName);
  }

  /** Verify the server's confirmation and decrypt the credential. */
  private async accept(v: Record<string, unknown>, keys: ReturnType<typeof deriveKeys>): Promise<void> {
    if (typeof v.mac !== 'string' || typeof v.sealed !== 'string') throw this.fail('sign-in-failed', 'Unexpected answer from the server');
    if (!macEqual(mac(keys.serverMac, 'server', keys.transcript), unb64u(v.mac))) {
      throw this.fail('sign-in-failed', 'The server did not prove it knows the pairing key. Nothing was accepted.');
    }
    const plain = await open(keys.enc, keys.transcript, unb64u(v.sealed));
    if (!plain) throw this.fail('sign-in-failed', 'The credential could not be decrypted. Nothing was accepted.');
    const c = JSON.parse(new TextDecoder().decode(plain)) as { token?: unknown; expires_at?: unknown };
    if (typeof c.token !== 'string' || typeof c.expires_at !== 'number') throw this.fail('sign-in-failed', 'Unexpected credential');
    this.setCredential({ token: c.token, expiresAt: c.expires_at });
  }

  private async spake2(windowId: string, code: string, name?: string): Promise<PairingAttempt> {
    this.emitter.set('pending');
    const run = async (): Promise<void> => {
      const client = spake2Start(new TextEncoder().encode(code));
      const start = await this.post('/api/pair/spake2/start', { window_id: windowId, msg: b64u(client.msg) });
      if (start.status !== 200 || typeof start.json.session_id !== 'string' || typeof start.json.msg !== 'string') {
        throw this.fail('sign-in-failed', start.status === 400 ? 'The server did not understand the request.' : FAILED);
      }
      const msgB = unb64u(start.json.msg);
      let shared: Uint8Array;
      try { shared = client.finish(msgB); } catch { throw this.fail('sign-in-failed', 'The server sent an invalid message'); }
      const keys = deriveKeys(shared, transcript('spake2', [new TextEncoder().encode(windowId), client.msg, msgB]));
      const confirm = await this.post('/api/pair/spake2/confirm', {
        session_id: start.json.session_id, mac: b64u(mac(keys.clientMac, 'client', keys.transcript)), ...(name ? { name } : {}),
      });
      if (confirm.status !== 200) throw this.fail('sign-in-failed', FAILED);
      await this.accept(confirm.json, keys);
    };
    const done = run().catch((e) => {
      this.emitter.set(this.cred ? 'ready' : 'signed-out');
      throw e;
    });
    done.catch(() => undefined); // observed here; callers still receive the rejection when they await it
    this.attempt = { cancel: () => undefined };
    return { done, cancel: () => undefined };
  }

  private async ecdh(windowId: string, name?: string): Promise<PairingAttempt> {
    this.emitter.set('pending');
    const abandon = (e: unknown): never => { this.emitter.set(this.cred ? 'ready' : 'signed-out'); throw e; };
    let cancelled = false;
    let wake: (() => void) | null = null;
    const cancel = () => { cancelled = true; wake?.(); };
    this.attempt = { cancel };
    try {
      const subtle = this.env.crypto.subtle;
      const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pubC = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      const start = await this.post('/api/pair/ecdh/start', { window_id: windowId, pub: b64u(pubC) });
      if (start.status !== 200 || typeof start.json.session_id !== 'string' || typeof start.json.pub !== 'string') {
        throw this.fail('sign-in-failed', FAILED);
      }
      const pubS = unb64u(start.json.pub);
      const serverKey = await subtle.importKey('raw', pubS as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: serverKey }, pair.privateKey, 256));
      const t = transcript('ecdh', [new TextEncoder().encode(windowId), pubC, pubS]);
      const keys = deriveKeys(shared, t);
      const fp = fingerprintOf(t);
      const expiresAt = typeof start.json.expires_at === 'number' ? start.json.expires_at : this.env.now() + 120_000;
      const sessionId = start.json.session_id;

      const done = (async () => {
        try {
          for (;;) {
            if (cancelled) throw this.fail('cancelled', 'Pairing cancelled');
            if (this.env.now() >= expiresAt) throw this.fail('sign-in-failed', 'The pairing window expired before the operator approved.');
            const r = await this.post('/api/pair/ecdh/result', {
              session_id: sessionId, mac: b64u(mac(keys.clientMac, 'client', keys.transcript)), ...(name ? { name } : {}),
            });
            if (r.status !== 200) throw this.fail('sign-in-failed', FAILED);
            if (r.json.status === 'denied') throw this.fail('cancelled', 'The operator rejected this device.');
            if (r.json.status === 'approved') { await this.accept(r.json, keys); return; }
            await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, this.env.pollIntervalMs); });
          }
        } catch (e) {
          this.emitter.set(this.cred ? 'ready' : 'signed-out');
          throw e;
        }
      })();
      done.catch(() => undefined); // observed here; callers still receive the rejection when they await it
      return { fingerprint: fp, publicKey: b64u(pubC), done, cancel };
    } catch (e) {
      return abandon(e);
    }
  }
}

