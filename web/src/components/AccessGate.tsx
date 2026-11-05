import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  beginAccessLogin, ensureAccess, installAccessWatchers, isExpired,
  loginEntryUrl, recheckAccess, subscribeExpired, type AccessProbeResult,
} from '../utils/access';

type GateState = AccessProbeResult | 'checking';

/** Renders children only after the proxy session is confirmed (bootstrap gate). */
export function AccessGate({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<GateState>('checking');

  const check = () => {
    setState('checking');
    void ensureAccess().then((r) => {
      setState(r);
      if (r === 'needs-auth') beginAccessLogin(); // no app UI yet → navigate straight away
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
  useEffect(() => subscribeExpired(setExpired), []);
  if (!expired) return null;
  return (
    <div class="access-overlay">
      <div role="alertdialog" aria-modal="true" aria-labelledby="relogin-title" class="access-box">
        <h2 id="relogin-title">Session expired</h2>
        <p>Your sign-in has expired, so copa can't reach the server until you sign in again.</p>
        <button type="button" class="access-btn" onClick={() => location.assign(loginEntryUrl())}>
          Sign in again
        </button>
        <button type="button" class="access-link" onClick={() => void recheckAccess()}>
          I've signed in — retry
        </button>
      </div>
    </div>
  );
}
