/**
 * Identity-proxy session gate (Cloudflare Access / Zero Trust).
 *
 * The service worker serves the cached shell even after the proxy session
 * died, so API calls and WebSockets then fail with redirects or HTML. This
 * module probes a proxy-protected same-origin route and only a strict
 * positive answer (204 + header) lets protected networking start. Login is
 * always a top-level navigation, never fetch/XHR. The session cookie is never
 * read from JavaScript.
 */

export type AccessProbeResult = 'ready' | 'needs-auth' | 'offline' | 'error';

const PROBE_URL = '/__access/probe';
const LOGIN_URL = '/__access/login';

export async function probeAccess(): Promise<AccessProbeResult> {
  try {
    const res = await fetch(PROBE_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 204 && res.headers.get('x-app-access-probe') === 'ok') return 'ready';
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return 'needs-auth';
    // copa never authenticates this route itself, so a 401/403 here can only
    // come from an identity proxy in front of it: treat it like a redirect.
    // A policy denial then ends on the manual sign-in screen (login-loop guard).
    if (res.status === 401 || res.status === 403) return 'needs-auth';
    // No identity proxy / no probe route (static hosting, plain `copa serve`
    // without a proxy in front): nothing can expire, don't block the app.
    if (res.status === 404) return 'ready';
    return 'error';
  } catch {
    return navigator.onLine ? 'error' : 'offline';
  }
}

// Serialize probes so concurrent failures can't start several navigations.
let inFlight: Promise<AccessProbeResult> | undefined;

export function ensureAccess(): Promise<AccessProbeResult> {
  inFlight ??= probeAccess().finally(() => { inFlight = undefined; });
  return inFlight;
}

export function loginEntryUrl(): string {
  const returnTo = `${location.pathname}${location.search}${location.hash}`;
  return `${LOGIN_URL}?return=${encodeURIComponent(returnTo)}`;
}

/** Top-level navigation: the only way the IdP cookie flow can complete. */
export function beginAccessLogin(): void {
  location.assign(loginEntryUrl());
}

// --- in-session "session expired" state (rendered by <ReloginOverlay>) ---

let expired = false;
const listeners = new Set<(expired: boolean) => void>();

export function subscribeExpired(fn: (expired: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function isExpired(): boolean {
  return expired;
}

function setExpired(value: boolean): void {
  if (expired === value) return;
  expired = value;
  listeners.forEach((fn) => fn(value));
}

export function showRelogin(): void {
  setExpired(true);
}

// --- restore signal: bumps whenever an expired session becomes valid again ---

let epoch = 0;
const restoreListeners = new Set<(epoch: number) => void>();

export function getAccessEpoch(): number {
  return epoch;
}

/** Called after an expired session was confirmed valid again (no reload). */
export function subscribeRestored(fn: (epoch: number) => void): () => void {
  restoreListeners.add(fn);
  return () => { restoreListeners.delete(fn); };
}

/** Probe and raise the overlay on `needs-auth`. Returns the probe result. */
export async function recheckAccess(): Promise<AccessProbeResult> {
  const result = await ensureAccess();
  if (result === 'needs-auth') {
    showRelogin();
  } else if (result === 'ready') {
    if (expired) {
      epoch += 1;
      setExpired(false);
      restoreListeners.forEach((fn) => fn(epoch));
    }
  }
  return result;
}

// --- bootstrap login-loop guard ---

const LOGIN_STAMP_KEY = 'copa.access.loginAt';
export const LOGIN_LOOP_WINDOW_MS = 60_000;

/**
 * False when this tab already navigated to sign-in automatically within the
 * window, i.e. signing in did not take effect (blocked cookies, policy
 * denial): the caller must then offer a manual action instead of looping.
 */
export function mayAutoLogin(now = Date.now()): boolean {
  try {
    const stamp = Number(sessionStorage.getItem(LOGIN_STAMP_KEY));
    return !(stamp > 0 && now - stamp < LOGIN_LOOP_WINDOW_MS);
  } catch {
    return true; // storage unavailable: degrade to always navigating
  }
}

export function markAutoLogin(now = Date.now()): void {
  try { sessionStorage.setItem(LOGIN_STAMP_KEY, String(now)); } catch { /* ignore */ }
}

export function clearAutoLogin(): void {
  try { sessionStorage.removeItem(LOGIN_STAMP_KEY); } catch { /* ignore */ }
}

/** Is this server URL on the app's own origin (i.e. behind the same proxy session)? */
export function isSameOrigin(serverUrl: string): boolean {
  try {
    return new URL(serverUrl, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Call after a protected request failed unexpectedly (network error, redirect
 * or HTML instead of the API's JSON/text). App 401/403 are not proxy
 * intercepts — don't call this for those. No-op for cross-origin servers,
 * whose session this page cannot probe.
 */
export function recheckAfterFailure(serverUrl: string): void {
  if (isSameOrigin(serverUrl)) void recheckAccess();
}

export type ConnectDecision = 'ready' | 'needs-auth' | 'paused';

/**
 * Gate for reconnect loops. `ready`: connect. `needs-auth`: stay idle until
 * the restore signal fires. `paused`: offline/unreachable, retry with backoff.
 */
export async function canConnect(serverUrl: string): Promise<ConnectDecision> {
  if (!isSameOrigin(serverUrl)) return 'ready';
  const result = await recheckAccess();
  return result === 'ready' || result === 'needs-auth' ? result : 'paused';
}

let watching = false;

/** Re-probe when the tab returns to the foreground or the SW reports expiry. */
export function installAccessWatchers(): void {
  if (watching) return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void recheckAccess();
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if ((e.data as { type?: string } | null)?.type === 'AUTH_EXPIRED') void recheckAccess();
  });
  window.addEventListener('online', () => { void recheckAccess(); });
}
