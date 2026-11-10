/** A fake browser for the OAuth2 provider: popups that behave like a user (or a COOP-severed window). */
import type { MessageLike, OAuth2Env, PopupLike } from '../src/auth';

/** The real fetch, captured before any test replaces the global one. */
const realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  } as Storage;
}

export type PopupScript = (popup: FakePopup, url: string) => Promise<void> | void;

export class FakePopup implements PopupLike {
  closed = false;
  history: string[] = [];
  private href = 'about:blank';
  readonly location: { href: string };
  constructor(onNavigate: (p: FakePopup, url: string) => void) {
    const self = this;
    this.location = {
      get href() { return self.href; },
      set href(url: string) { self.href = url; self.history.push(url); if (url !== 'about:blank') onNavigate(self, url); },
    };
  }
  close(): void { this.closed = true; }
  /** The URL of the sign-in page the widget navigated to. */
  get loginUrl(): URL | null {
    const u = this.history.find((h) => h !== 'about:blank');
    return u ? new URL(u) : null;
  }
}

export interface Fake {
  env: OAuth2Env;
  popups: FakePopup[];
  openCalls: { url: string; features: string }[];
  /** Deliver a postMessage to the widget window. */
  emit(m: MessageLike): void;
  fetchLog: { method: string; url: string; body?: string }[];
  navigated: string[];
  replaced: string[];
  /** The live options (e.g. flip `blocked` while a test runs). */
  options: FakeOptions;
  /** The page address as the provider would see it now. */
  page: { href: string };
}

export interface FakeOptions {
  script: PopupScript;
  blocked?: boolean;
  origin?: string;
  storage?: { session?: Storage; local?: Storage };
  pollIntervalMs?: number;
  closedGraceMs?: number;
  loginTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  lock?: OAuth2Env['lock'];
  /** The page address (redirect mode); `navigated`/`replaced` record what the provider did. */
  href?: string;
}

export function fakeEnv(o: FakeOptions): Fake {
  const popups: FakePopup[] = [];
  const openCalls: Fake['openCalls'] = [];
  const listeners = new Set<(e: MessageLike) => void>();
  const fetchLog: Fake['fetchLog'] = [];
  const navigated: string[] = [];
  const replaced: string[] = [];
  const page = { href: o.href ?? 'http://localhost:5180/app/index.html?tab=1' };
  const baseFetch = o.fetch ?? realFetch;
  const logged: typeof fetch = async (input, init) => {
    fetchLog.push({ method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? init.body : undefined });
    return baseFetch(input, init);
  };
  const env: OAuth2Env = {
    open(url, _name, features) {
      openCalls.push({ url, features });
      if (o.blocked) return null;
      const p = new FakePopup((pop, u) => { void Promise.resolve(o.script(pop, u)); });
      popups.push(p);
      return p;
    },
    onMessage(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    fetch: logged,
    crypto: globalThis.crypto,
    storage: (kind) => o.storage?.[kind] ?? null,
    origin: () => o.origin ?? new URL(page.href).origin,
    location: () => ({ href: page.href, hash: new URL(page.href).hash }),
    navigate: (url) => { navigated.push(url); },
    replaceUrl: (url) => { replaced.push(url); page.href = url; },
    lock: o.lock,
    now: o.now ?? (() => Date.now()),
    pollIntervalMs: o.pollIntervalMs ?? 30,
    closedGraceMs: o.closedGraceMs ?? 200,
    loginTimeoutMs: o.loginTimeoutMs ?? 8000,
  };
  return { env, popups, openCalls, fetchLog, navigated, replaced, page, options: o, emit: (m) => listeners.forEach((l) => l(m)) };
}

// ── popup behaviours (what a user and the token service's pages do) ─────────────

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

export interface LoginOptions {
  user?: string;
  /** Deliver the result with postMessage (false = the opener was severed by COOP). */
  deliver?: boolean;
  /** The login page noticed it has no opener and told the service. */
  detached?: boolean;
  /** Close the window after finishing (the real result page does). */
  closeAfter?: boolean;
  /** The user takes this long before pressing Sign in. */
  delayMs?: number;
}

/** Load the sign-in page, press "Sign in" as `user`, and deliver the result like the result page does. */
export function loginAs(fake: () => Fake, o: LoginOptions = {}): PopupScript {
  return async (popup, url) => {
    const origin = new URL(url).origin;
    const page = await (await realFetch(url)).text();
    const loginId = /name="login_id" value="([^"]+)"/.exec(page)?.[1];
    if (!loginId) throw new Error('no sign-in form: ' + page.slice(0, 200));
    if (o.detached) {
      await realFetch(`${origin}/login/detached`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login_id: loginId }) });
      popup.closed = true; // what a COOP-severed window looks like from the opener
    }
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const user = o.user ?? 'alice';
    const res = await realFetch(`${origin}/login/submit`, form({ login_id: loginId, user, password: user, action: 'signin' }));
    const result = await res.text();
    const msg = /const msg = (\{.*?\});/.exec(result)?.[1];
    if (o.deliver !== false && msg) {
      fake().emit({ origin, source: popup, data: JSON.parse(msg) });
    }
    if (o.closeAfter !== false) popup.closed = true;
  };
}

/** Press "Cancel". */
export function cancelClick(fake: () => Fake): PopupScript {
  return async (popup, url) => {
    const origin = new URL(url).origin;
    const page = await (await realFetch(url)).text();
    const loginId = /name="login_id" value="([^"]+)"/.exec(page)![1];
    const result = await (await realFetch(`${origin}/login/submit`, form({ login_id: loginId, action: 'cancel' }))).text();
    fake().emit({ origin, source: popup, data: JSON.parse(/const msg = (\{.*?\});/.exec(result)![1]) });
    popup.closed = true;
  };
}

/** Load the page, then the user closes the window without doing anything. */
export const closeWithoutLogin: PopupScript = async (popup, url) => {
  await (await realFetch(url)).text();
  popup.closed = true;
};

/** The user never does anything. */
export const stayOpen: PopupScript = async (_popup, url) => { await (await realFetch(url)).text(); };

/** Web Locks stand-in: one queue per name, shared by every provider that gets the same instance. */
export function fakeLocks(): NonNullable<OAuth2Env['lock']> {
  const tails = new Map<string, Promise<unknown>>();
  return <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(name, run.catch(() => undefined));
    return run;
  };
}
