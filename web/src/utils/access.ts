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

/** Probe and raise the overlay on `needs-auth`. Returns the probe result. */
export async function recheckAccess(): Promise<AccessProbeResult> {
  const result = await ensureAccess();
  if (result === 'needs-auth') showRelogin();
  else if (result === 'ready') setExpired(false);
  return result;
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

/** Gate for reconnect loops: true only when networking may (re)start. */
export async function canConnect(serverUrl: string): Promise<boolean> {
  if (!isSameOrigin(serverUrl)) return true;
  return (await recheckAccess()) === 'ready';
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
