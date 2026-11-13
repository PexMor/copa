import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  beginAccessLogin, clearAutoLogin, ensureAccess, installAccessWatchers, isExpired,
  loginEntryUrl, markAutoLogin, mayAutoLogin, recheckAccess, subscribeExpired,
  type AccessProbeResult,
} from '../utils/access';

/** `manual`: automatic sign-in already ran and did not help; ask the user. */
type GateState = AccessProbeResult | 'checking' | 'manual';

/** Renders children only after the proxy session is confirmed (bootstrap gate). */
export function AccessGate({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<GateState>('checking');

  const check = () => {
    setState('checking');
    void ensureAccess().then((r) => {
      if (r === 'ready') clearAutoLogin();
      if (r === 'needs-auth') {
        // No app UI yet → navigate straight away, but only once: if we are
        // back within the window and still signed out, signing in did not
        // take effect (blocked cookies, policy denial) → don't loop.
        if (mayAutoLogin()) {
          markAutoLogin();
          setState(r);
          beginAccessLogin();
        } else {
          setState('manual');
        }
        return;
      }
      setState(r);
    });
  };

  useEffect(() => {
    check();
    installAccessWatchers();
  }, []);

  if (state === 'ready') {
    return (
      <>
        {children}
        <ReloginOverlay />
      </>
    );
  }

  return (
    <div class="access-screen" role="status">
      {state === 'checking' && <p>Checking sign-in…</p>}
      {state === 'needs-auth' && <p>Redirecting to sign in…</p>}
      {state === 'manual' && (
        <div class="access-box">
          <h2>Sign-in needed</h2>
          <p>
            You are still signed out after the last sign-in attempt. Your account may not be
            allowed to use copa, or the browser is blocking the sign-in cookie.
          </p>
          <button
            type="button"
            class="access-btn"
            onClick={() => { markAutoLogin(); location.assign(loginEntryUrl()); }}
          >
            Sign in
          </button>
          <button type="button" class="access-link" onClick={check}>Check again</button>
        </div>
      )}
      {(state === 'offline' || state === 'error') && (
        <div class="access-box">
          <p>{state === 'offline' ? 'You are offline.' : 'Could not reach the server.'}</p>
          <button type="button" class="access-btn" onClick={check}>Retry</button>
        </div>
      )}
    </div>
  );
}

/** Blocking prompt for a session that expired while the app was open. */
export function ReloginOverlay() {
  const [expired, setExpired] = useState(isExpired());
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => subscribeExpired(setExpired), []);

  // Stays open unless the probe confirms a valid session again.
  const retry = () => {
    setHint(null);
    void recheckAccess().then((r) => {
      if (r === 'needs-auth') setHint("Still signed out. Sign in first, then try again.");
      else if (r !== 'ready') setHint("Can't reach the server right now. Try again in a moment.");
    });
  };

  if (!expired) return null;
  return (
    <div class="access-overlay">
      <div role="alertdialog" aria-modal="true" aria-labelledby="relogin-title" class="access-box">
        <h2 id="relogin-title">Session expired</h2>
        <p>Your sign-in has expired, so copa can't reach the server until you sign in again.</p>
        <button type="button" class="access-btn" onClick={() => location.assign(loginEntryUrl())}>
          Sign in again
        </button>
        {hint && <p role="status" class="access-hint">{hint}</p>}
        <button type="button" class="access-link" onClick={retry}>
          I've signed in — retry
        </button>
      </div>
    </div>
  );
}
