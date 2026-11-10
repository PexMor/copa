import { checkUrl, type EndpointConfig, type OAuth2Auth } from '../config';
import { StateEmitter } from './emitter';
import { CopaAuthError, type AuthProvider, type AuthState, type InteractiveProvider } from './types';

/** The window returned by `window.open` (the parts we use). */
export interface PopupLike {
  closed: boolean;
  close(): void;
  location: { href: string };
}

export interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/** Everything the provider needs from the browser; replaceable in tests. */
export interface OAuth2Env {
  open(url: string, name: string, features: string): PopupLike | null;
  onMessage(fn: (e: MessageLike) => void): () => void;
  fetch: typeof fetch;
  crypto: Crypto;
  storage(kind: 'session' | 'local'): Storage | null;
  /** Run `fn` while holding a lock shared by all tabs of this origin (Web Locks API). */
  lock?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Origin of the page hosting the widget (sent to the token service). */
  origin(): string;
  /** The current page address (redirect mode returns here). */
  location(): { href: string; hash: string };
  /** Leave this page (redirect mode). */
  navigate(url: string): void;
  /** Replace the current address without reloading (to drop the login code from the URL). */
  replaceUrl(url: string): void;
  now(): number;
  pollIntervalMs: number;
  /** After `popup.closed`, keep polling this long before reporting a cancellation. */
  closedGraceMs: number;
  /** Give up waiting for the user after this long. */
  loginTimeoutMs: number;
}

export function browserEnv(): OAuth2Env {
  return {
    open: (url, name, features) => window.open(url, name, features),
    onMessage: (fn) => {
      const h = (e: MessageEvent) => fn(e);
      window.addEventListener('message', h);
      return () => window.removeEventListener('message', h);
    },
    fetch: (...a) => fetch(...a),
    crypto: globalThis.crypto,
    storage: (kind) => {
      try { return kind === 'session' ? window.sessionStorage : window.localStorage; } catch { return null; }
    },
    lock: (name, fn) => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      return locks ? locks.request(name, fn) : fn();
    },
    origin: () => window.location.origin,
    location: () => ({ href: window.location.href, hash: window.location.hash }),
    navigate: (url) => { window.location.assign(url); },
    replaceUrl: (url) => { window.history.replaceState(window.history.state, '', url); },
    now: () => Date.now(),
    pollIntervalMs: 1500,
    closedGraceMs: 2500,
    loginTimeoutMs: 5 * 60_000,
  };
}

interface Endpoints {
  login: string;
  poll?: string;
  token: string;
  refresh: string;
  logout: string;
}

interface Tokens {
  access: string;
  accessExpiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}

/** Renew when the access token has less than this left. */
export const RENEW_MARGIN_MS = 60_000;
const STORAGE_PREFIX = 'copa-widget:oauth2:';

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A fresh PKCE-style pair: the verifier stays here, only its S256 challenge goes to the service. */
async function newPair(crypto: Crypto): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64u(digest) };
}

const JSON_POST = { 'Content-Type': 'application/json' } as const;

/**
 * Sign-in through an external token service, in a popup.
 *
 * The service performs the OAuth2/OIDC exchange with the identity provider and
 * returns copa-audience access tokens plus a refresh token; the widget only
 * opens the popup, redeems a single-use login code with its own secret
 * (`verifier`) and renews the access token. Nothing but the login code crosses
 * the popup boundary — never a token, never in a URL.
 */
export class OAuth2Provider implements AuthProvider, InteractiveProvider {
  readonly method = 'oauth2' as const;

  private readonly emitter = new StateEmitter('signed-out');
  private tokens: Tokens | null = null;
  private endpointsPromise: Promise<Endpoints> | null = null;
  private refreshing: Promise<boolean> | null = null;
  private restoring: Promise<void> | null = null;
  private signingIn: Promise<void> | null = null;
  private abortSignIn: (() => void) | null = null;

  constructor(
    private readonly endpoint: EndpointConfig,
    private readonly auth: OAuth2Auth,
    private readonly env: OAuth2Env = browserEnv(),
  ) {
    const returning = this.completeRedirect();
    if (returning) this.restoring = returning;
    else if (this.persistKind()) this.restoring = this.restore();
  }

  /** Why the last sign-in (or returning redirect) failed; cleared by the next attempt. */
  lastError: CopaAuthError | null = null;

  state(): AuthState { return this.emitter.state; }

  onChange(cb: (state: AuthState) => void): () => void { return this.emitter.subscribe(cb); }

  /** Start discovery early so a later click can open the login URL without waiting. */
  warmUp(): Promise<void> {
    return this.endpoints().then(() => undefined, () => undefined);
  }

  // ── endpoints ────────────────────────────────────────────────────────────────

  private endpoints(): Promise<Endpoints> {
    this.endpointsPromise ??= this.discover().catch((e) => { this.endpointsPromise = null; throw e; });
    return this.endpointsPromise;
  }

  private checked(name: string, url: unknown): string {
    if (typeof url !== 'string' || url === '') {
      throw new CopaAuthError('sign-in-failed', `The token service does not advertise ${name}`);
    }
    const problem = checkUrl(url);
    if (problem) throw new CopaAuthError('sign-in-failed', `The token service's ${name} is unusable: ${problem.message}`);
    return url;
  }

  private async discover(): Promise<Endpoints> {
    const a = this.auth;
    if (!a.tokenService) {
      return {
        login: this.checked('loginUrl', a.loginUrl),
        poll: a.pollUrl ? this.checked('pollUrl', a.pollUrl) : undefined,
        token: this.checked('tokenUrl', a.tokenUrl),
        refresh: this.checked('refreshUrl', a.refreshUrl),
        logout: this.checked('logoutUrl', a.logoutUrl),
      };
    }
    const url = `${a.tokenService.replace(/\/+$/, '')}/.well-known/copa-token-service`;
    let doc: Record<string, unknown>;
    try {
      const res = await this.env.fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = await res.json() as Record<string, unknown>;
    } catch (e) {
      throw new CopaAuthError('sign-in-failed', `Cannot read the token service's discovery document (${e instanceof Error ? e.message : String(e)})`);
    }
    return {
      login: this.checked('login_url', doc.login_url),
      poll: doc.poll_url ? this.checked('poll_url', doc.poll_url) : undefined,
      token: this.checked('token_url', doc.token_url),
      refresh: this.checked('refresh_url', doc.refresh_url),
      logout: this.checked('logout_url', doc.logout_url),
    };
  }

  // ── tokens ───────────────────────────────────────────────────────────────────

  private persistKind(): 'session' | 'local' | null {
    const p = this.auth.persist;
    return p === 'session' || p === 'local' ? p : null;
  }

  private storageKey(): string { return STORAGE_PREFIX + this.endpoint.id; }

  private persist(): void {
    const kind = this.persistKind();
    const store = kind ? this.env.storage(kind) : null;
    if (!store) return;
    try {
      if (this.tokens) {
        store.setItem(this.storageKey(), JSON.stringify({ r: this.tokens.refresh, e: this.tokens.refreshExpiresAt }));
      } else {
        store.removeItem(this.storageKey());
      }
    } catch { /* storage unavailable: the session just won't survive a reload */ }
  }

  private async restore(): Promise<void> {
    const kind = this.persistKind();
    const store = kind ? this.env.storage(kind) : null;
    let saved: { r?: unknown; e?: unknown } | null = null;
    try {
      const raw = store?.getItem(this.storageKey());
      saved = raw ? JSON.parse(raw) as { r?: unknown; e?: unknown } : null;
    } catch { saved = null; }
    if (!saved || typeof saved.r !== 'string' || typeof saved.e !== 'number' || saved.e <= this.env.now()) {
      if (saved) { try { store?.removeItem(this.storageKey()); } catch { /* ignore */ } }
      return;
    }
    this.tokens = { access: '', accessExpiresAt: 0, refresh: saved.r, refreshExpiresAt: saved.e };
    this.emitter.set('pending');
    const ok = await this.refresh();
    if (!ok && this.emitter.state === 'pending') this.clear('signed-out');
  }

  private setTokens(body: unknown): void {
    const b = body as Record<string, unknown>;
    if (typeof b?.access_token !== 'string' || typeof b.refresh_token !== 'string'
      || typeof b.access_expires_at !== 'number' || typeof b.refresh_expires_at !== 'number') {
      throw new CopaAuthError('sign-in-failed', 'The token service returned an unexpected response');
    }
    this.tokens = {
      access: b.access_token,
      accessExpiresAt: b.access_expires_at,
      refresh: b.refresh_token,
      refreshExpiresAt: b.refresh_expires_at,
    };
    this.persist();
    this.emitter.set('ready');
  }

  private clear(state: AuthState): void {
    this.tokens = null;
    this.persist();
    this.emitter.set(state);
  }

  async getHeader(): Promise<string> {
    if (this.restoring) await this.restoring;
    const t0 = this.tokens;
    if (!t0) throw new CopaAuthError('not-authenticated', 'Not signed in');
    if (t0.accessExpiresAt - this.env.now() < RENEW_MARGIN_MS) await this.refresh();
    const t = this.tokens;
    if (!t || t.accessExpiresAt <= this.env.now()) {
      throw new CopaAuthError('not-authenticated', 'The session expired; please sign in again');
    }
    return `Bearer ${t.access}`;
  }

  /** Renew the access token with the refresh token (single flight). False when that is not possible. */
  refresh(): Promise<boolean> {
    // Tabs that share a persisted session must not rotate the same refresh token concurrently
    // (the service treats a reused token as theft and revokes the session): serialize them.
    const run = () => (this.persistKind() && this.env.lock
      ? this.env.lock(`copa-widget-refresh:${this.endpoint.id}`, () => this.doRefresh())
      : this.doRefresh());
    this.refreshing ??= run().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Another tab may have rotated the refresh token already: use the newest one in storage. */
  private adoptStored(): void {
    const kind = this.persistKind();
    const store = kind ? this.env.storage(kind) : null;
    if (!store || !this.tokens) return;
    try {
      const raw = store.getItem(this.storageKey());
      if (!raw) return;
      const saved = JSON.parse(raw) as { r?: unknown; e?: unknown };
      if (typeof saved.r === 'string' && typeof saved.e === 'number' && saved.r !== this.tokens.refresh && saved.e >= this.tokens.refreshExpiresAt) {
        this.tokens = { ...this.tokens, refresh: saved.r, refreshExpiresAt: saved.e, accessExpiresAt: 0 };
      }
    } catch { /* unreadable: keep ours */ }
  }

  private async doRefresh(): Promise<boolean> {
    this.adoptStored();
    const t = this.tokens;
    if (!t) return false;
    if (t.refreshExpiresAt <= this.env.now()) { this.clear('expired'); return false; }
    let eps: Endpoints;
    try { eps = await this.endpoints(); } catch { return false; } // transient: keep what we have
    let res: Response;
    try {
      res = await this.env.fetch(eps.refresh, {
        method: 'POST', headers: JSON_POST, credentials: 'omit', body: JSON.stringify({ refresh_token: t.refresh }),
      });
    } catch { return false; } // network trouble must not sign the user out
    if (res.status === 400 || res.status === 401) { this.clear('expired'); return false; }
    if (!res.ok) return false;
    try { this.setTokens(await res.json()); } catch { return false; }
    return true;
  }

  // ── sign in ──────────────────────────────────────────────────────────────────

  /** Abort a sign-in that is waiting for the user. */
  cancelSignIn(): void { this.abortSignIn?.(); }

  /**
   * Must be called from a user gesture (click): the popup is opened synchronously,
   * before anything is awaited, so popup blockers let it through.
   */
  signIn(): Promise<void> {
    if (this.auth.flow === 'redirect') return this.signInRedirect();
    if (this.signingIn) return this.signingIn;
    this.lastError = null;
    const a = this.auth;
    const features = `popup=yes,width=${a.popup?.width ?? 480},height=${a.popup?.height ?? 640}`;
    const popup = this.env.open('about:blank', 'copa-login', features);
    if (!popup) {
      this.lastError = new CopaAuthError('popup-blocked', 'The browser blocked the sign-in window. Allow pop-ups for this site and try again.');
      return Promise.reject(this.lastError);
    }
    const before = this.emitter.state;
    this.emitter.set('pending');
    this.signingIn = this.runSignIn(popup)
      .catch((e) => {
        this.lastError = e instanceof CopaAuthError ? e : new CopaAuthError('sign-in-failed', String(e));
        this.emitter.set(this.tokens ? 'ready' : before === 'expired' ? 'expired' : 'signed-out');
        throw e;
      })
      .finally(() => {
        this.signingIn = null;
        this.abortSignIn = null;
        try { popup.close(); } catch { /* already closed */ }
      });
    return this.signingIn;
  }

  private async runSignIn(popup: PopupLike): Promise<void> {
    const [eps, pair] = await Promise.all([this.endpoints(), newPair(this.env.crypto)]);
    const login = new URL(eps.login);
    login.searchParams.set('audience', this.auth.audience ?? new URL(this.endpoint.url).origin);
    login.searchParams.set('origin', this.env.origin());
    login.searchParams.set('challenge', pair.challenge);
    popup.location.href = login.toString();

    const code = await this.awaitCode(popup, eps, pair.verifier, login.origin);
    let res: Response;
    try {
      res = await this.env.fetch(eps.token, {
        method: 'POST', headers: JSON_POST, credentials: 'omit', body: JSON.stringify({ login_code: code, verifier: pair.verifier }),
      });
    } catch (e) {
      throw new CopaAuthError('sign-in-failed', `Cannot reach the token service (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) throw new CopaAuthError('sign-in-failed', `The token service refused the sign-in (HTTP ${res.status})`);
    this.setTokens(await res.json());
  }

  /** Resolves with the single-use login code, delivered by `postMessage` or found by polling. */
  private awaitCode(popup: PopupLike, eps: Endpoints, verifier: string, tokenOrigin: string): Promise<string> {
    const env = this.env;
    return new Promise<string>((resolve, reject) => {
      const started = env.now();
      let closedAt: number | null = null;
      let detached = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let off: (() => void) | undefined;
      let finished = false;

      const finish = (fn: () => void) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        off?.();
        fn();
      };
      this.abortSignIn = () => finish(() => reject(new CopaAuthError('cancelled', 'Sign-in cancelled')));

      off = env.onMessage((e) => {
        // Only the sign-in window, only from the token service's origin.
        if (e.origin !== tokenOrigin || e.source !== popup) return;
        const d = e.data as { type?: unknown; login_code?: unknown; error?: unknown } | null;
        if (d?.type === 'copa-login' && typeof d.login_code === 'string') {
          finish(() => resolve(d.login_code as string));
        } else if (d?.type === 'copa-login-error') {
          const why = typeof d.error === 'string' ? d.error : 'failed';
          finish(() => reject(new CopaAuthError(why === 'cancelled' || why === 'access_denied' ? 'cancelled' : 'sign-in-failed',
            why === 'cancelled' ? 'Sign-in cancelled' : `Sign-in failed: ${why}`)));
        }
      });

      const tick = async () => {
        if (finished) return;
        if (popup.closed && closedAt === null) closedAt = env.now();
        if (eps.poll) {
          try {
            const res = await env.fetch(eps.poll, {
              method: 'POST', headers: JSON_POST, credentials: 'omit', body: JSON.stringify({ verifier }),
            });
            if (res.ok) {
              const r = await res.json() as { status?: string; login_code?: string; detached?: boolean };
              detached = r.detached === true;
              if (r.status === 'ok' && typeof r.login_code === 'string') { finish(() => resolve(r.login_code as string)); return; }
              if (r.status === 'denied') { finish(() => reject(new CopaAuthError('cancelled', 'Sign-in cancelled'))); return; }
            }
          } catch { /* transient: try again */ }
        }
        if (finished) return;
        // A popup that lost its opener (COOP) reports closed=true while still open: trust only
        // the service's `detached` signal to ignore it.
        if (closedAt !== null && !detached && env.now() - closedAt >= env.closedGraceMs) {
          finish(() => reject(new CopaAuthError('cancelled', 'The sign-in window was closed')));
          return;
        }
        if (env.now() - started >= env.loginTimeoutMs) {
          finish(() => reject(new CopaAuthError('sign-in-failed', 'Sign-in timed out')));
          return;
        }
        timer = setTimeout(tick, env.pollIntervalMs);
      };
      timer = setTimeout(tick, env.pollIntervalMs);
    });
  }

  // ── redirect flow (no pop-up) ─────────────────────────────────────────────────

  private redirectKey(): string { return `${STORAGE_PREFIX}redirect:${this.endpoint.id}`; }

  /**
   * Sign in by navigating this page to the token service and back. The page state is
   * lost, so the secret verifier and an opaque `state` wait in session storage until
   * the service returns the user with the login code in the URL *fragment*.
   */
  async signInRedirect(): Promise<void> {
    this.lastError = null;
    const store = this.env.storage('session');
    if (!store) {
      this.lastError = new CopaAuthError('sign-in-failed', 'Signing in on this page needs session storage, which is unavailable');
      throw this.lastError;
    }
    const [eps, pair] = await Promise.all([this.endpoints(), newPair(this.env.crypto)]);
    const state = b64u(this.env.crypto.getRandomValues(new Uint8Array(16)));
    const here = new URL(this.env.location().href);
    here.hash = '';
    try {
      store.setItem(this.redirectKey(), JSON.stringify({ v: pair.verifier, s: state, t: this.env.now() }));
    } catch {
      this.lastError = new CopaAuthError('sign-in-failed', 'Signing in on this page needs session storage, which is unavailable');
      throw this.lastError;
    }
    const login = new URL(eps.login);
    login.searchParams.set('mode', 'redirect');
    login.searchParams.set('audience', this.auth.audience ?? new URL(this.endpoint.url).origin);
    login.searchParams.set('redirect_uri', here.toString());
    login.searchParams.set('state', state);
    login.searchParams.set('challenge', pair.challenge);
    this.emitter.set('pending');
    this.env.navigate(login.toString());
  }

  /**
   * On page load: did the token service just send the user back to us? Returns a promise when
   * this provider owns the returning sign-in (its stored `state` matches), otherwise null.
   */
  private completeRedirect(): Promise<void> | null {
    const loc = this.env.location();
    if (!loc.hash.includes('copa_login_')) return null;
    const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
    const state = params.get('state');
    const code = params.get('copa_login_code');
    const error = params.get('copa_login_error');

    const store = this.env.storage('session');
    type Saved = { v?: unknown; s?: unknown; t?: unknown };
    let saved = null as Saved | null;
    try {
      const raw = store?.getItem(this.redirectKey());
      if (raw) saved = JSON.parse(raw) as Saved;
    } catch { saved = null; }
    // Not ours (another endpoint's sign-in, or a stale fragment): leave the URL alone.
    if (!saved || typeof saved.s !== 'string' || !state || saved.s !== state) return null;

    // Ours: take the secret out of storage and the code out of the address bar, whatever happens next.
    try { store?.removeItem(this.redirectKey()); } catch { /* ignore */ }
    for (const k of ['copa_login_code', 'copa_login_error', 'state']) params.delete(k);
    const clean = new URL(loc.href);
    clean.hash = params.toString() ? `#${params.toString()}` : '';
    try { this.env.replaceUrl(clean.toString()); } catch { /* ignore */ }

    const stale = typeof saved.t === 'number' && this.env.now() - saved.t > 10 * 60_000;
    const verifier = saved.v;
    return (async () => {
      this.emitter.set('pending');
      try {
        if (error) {
          const cancelled = error === 'cancelled' || error === 'access_denied';
          throw new CopaAuthError(cancelled ? 'cancelled' : 'sign-in-failed', cancelled ? 'Sign-in cancelled' : `Sign-in failed: ${error}`);
        }
        if (stale || !code || typeof verifier !== 'string') {
          throw new CopaAuthError('sign-in-failed', 'The sign-in could not be completed; please try again');
        }
        const eps = await this.endpoints();
        const res = await this.env.fetch(eps.token, {
          method: 'POST', headers: JSON_POST, credentials: 'omit', body: JSON.stringify({ login_code: code, verifier }),
        });
        if (!res.ok) throw new CopaAuthError('sign-in-failed', `The token service refused the sign-in (HTTP ${res.status})`);
        this.setTokens(await res.json());
      } catch (e) {
        this.lastError = e instanceof CopaAuthError ? e : new CopaAuthError('sign-in-failed', String(e));
        this.emitter.set('signed-out');
      }
    })();
  }

  // ── sign out ─────────────────────────────────────────────────────────────────

  async signOut(): Promise<void> {
    const t = this.tokens;
    this.cancelSignIn();
    this.clear('signed-out');
    if (!t) return;
    try {
      const eps = await this.endpoints();
      await this.env.fetch(eps.logout, {
        method: 'POST', headers: JSON_POST, credentials: 'omit', body: JSON.stringify({ refresh_token: t.refresh }),
      });
    } catch { /* best effort: the local session is gone either way */ }
  }
}
