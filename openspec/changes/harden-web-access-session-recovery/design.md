# Design

## Context

Already in place and kept as-is (see proposal for the review findings):

- Server: `GET /__access/probe` (204 + `X-App-Access-Probe: ok`, `no-store`) and `GET /__access/login?return=` (validated 302), with unit tests in `src/server/access.rs`. Both carry no secret and only mean something because the proxy in front protects them.
- `web/src/utils/access.ts`: `probeAccess` (strict positive signal, `redirect: 'manual'`), serialized `ensureAccess`, `recheckAccess` (raises the overlay), `recheckAfterFailure` / `canConnect` (same-origin only), watchers for `visibilitychange`, `online` and SW `AUTH_EXPIRED`.
- `AccessGate` (bootstrap gate) and `ReloginOverlay` (in-session), wired in `web/src/main.tsx`.
- `web/public/sw.js`: network-only for `/api`, `/ws`, `/__access/`; `isAuthIntercept` guard before `cache.put`; `AUTH_EXPIRED` broadcast; probe on `activate`.

Constraints: single-file Rust server stays untouched; the web app is a Preact app built with Vite and `yarn`; `web-core` is shared with the widget and must not gain DOM or app-state dependencies.

## Goals / Non-Goals

**Goals:**
- After any expiry, with or without a reload, the user can sign in and the app returns to a working state with live connections restored.
- One central place decides "may we talk to the protected origin"; hooks do not roll their own checks.
- No login loop and no silent "success" on a login page.
- Behaviour is covered by automated tests.

**Non-Goals:**
- Cross-origin protected servers, the widget, MQTT, sub-path hosting (see proposal).
- Any server-side change to the probe or login routes.
- Browser-driven end-to-end tests. The user verifies in a real browser against Cloudflare.

## Decisions

**1. Access-restored signal instead of per-hook polling.**
`access.ts` already owns the `expired` flag and a subscriber set. Add a monotonically increasing `accessEpoch` that increments each time the state moves from expired to ready, exposed as `subscribeRestored(fn)` plus a small `useAccessEpoch()` hook. `useWebSocket` and `useHistory` include the epoch in their effect dependencies, so a restore tears down and recreates the connection through their existing code path, and `useHistory` already refreshes on `ws.onopen`. `useCapabilities` and `useServerVersion` do the same. Alternative considered: `location.reload()` on restore. It is simpler and matches the skill's "reload after re-login" advice, but it drops unsent clipboard text the user typed before the expiry. Reload stays as the fallback for the bootstrap path, where there is no state to lose.

**2. Reconnect gating stays in `canConnect`, but a refused reconnect is a pause, not an exit.**
When `canConnect` is false the hooks stay idle and rely on the epoch change to restart. When the probe result is `offline` or `error` (not `needs-auth`) the hook schedules a normal backoff retry instead, so a flaky network does not strand the socket. This needs `canConnect` to return the probe result (`'ready' | 'needs-auth' | 'paused'`) rather than a boolean.

**3. Bootstrap loop guard with `sessionStorage`.**
Before `beginAccessLogin()` from `AccessGate`, write `copa.access.loginAt = Date.now()`. If the stamp is younger than 60 s when `needs-auth` is seen again, render a manual "Sign in" button and a short explanation instead of navigating. Clear the stamp when the probe reports `ready`. `sessionStorage` is wrapped in try/catch; if unavailable the guard degrades to the current behaviour. Alternative: a counter in the URL. Rejected, because the return target must stay clean.

**4. Probe classification.**
`3xx` / `opaqueredirect` → `needs-auth` (as now). `401` and `403` on the probe → `needs-auth` as well: copa itself never authenticates this route, so such a status can only come from a proxy, and sending the user to the login entry is the right recovery. A policy denial then ends on the manual sign-in screen through decision 3. `404` stays `ready` (no proxy in front, documented in the spec). Everything else → `error`. To confirm during implementation against the real Access tunnel: what Cloudflare answers to `fetch` with `Accept: application/json` and an absent cookie. The classification above covers both a 302 and a 401/403 so the outcome does not hinge on it.

**5. One REST client.**
Port `useClipboard` to `CopaApi` (add `getClipboard` / `postClipboard`, which already exist in `web-core`). This brings the HTML check and `onFailure` hook to `push()` for free and removes the duplicated header and HTML logic. `fetchServerVersion` is changed so it distinguishes three outcomes: valid payload, "no endpoint" (404 or JSON without version fields), and "unexpected" (network error or HTML). Only the last triggers `recheckAfterFailure` and is not logged as an older server.

**6. Service worker: no behavioural change planned.**
Reviewed against the skill's checklist and it conforms, so `sw.js` is left untouched and has no automated test (it is a plain script without a test seam, and splitting it just for tests is not worth an extra file). It is verified by hand in the manual checklist.

**7. Tests with vitest in `web/`.**
Add `vitest` (+ `jsdom`) as dev dependencies with `yarn`, and a `test` script. Cover: probe mapping for 204+header, 204 without header, 302/opaqueredirect, 401/403, 404, 500, thrown error online and offline; probe serialization; `loginEntryUrl` for path, query and hash; loop guard; epoch increments only on expired→ready; HTML handling in the clipboard and version paths. Component rendering of `AccessGate` is tested with `@testing-library/preact` only if it is already a transitive need; otherwise the logic lives in `access.ts` and is tested there.

**8. Documentation.**
Add a short section (README or `docs/`) stating: keep `/__access/*` under the Access policy (never a Bypass policy), run the app and API on one origin, and how to simulate expiry (delete `CF_Authorization`). Add a `CHANGELOG.md` entry. Version bump follows the submodule rule in the project `CLAUDE.md`.

## Risks / Trade-offs

- **401/403 → `needs-auth`** could send a user into the login entry for a policy denial. Mitigated by the loop guard; the manual screen explains the situation.
- **Epoch-driven reconnect** touches the two live hooks. A regression there would show as duplicate sockets. Mitigation: the existing cleanup (`cancelled`, `onclose = null`) already runs on dependency change; add a test counting constructed sockets.
- **404 = ready** means a misconfigured proxy that hides the probe behind a 404 disables the gate silently. Accepted, since the alternative breaks plain `copa serve` and static hosting.
- **Cross-origin servers stay ungated.** A server on another origin behind its own Access session still fails silently. Documented limitation; fixing it needs credentialed CORS and a different return flow.
- **sessionStorage guard** can be defeated by private-window quirks; it only degrades to today's behaviour.
