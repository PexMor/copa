# Proposal

## Why

copa is deployed behind an identity-aware proxy (Cloudflare Access on the public hostname), and the web app is a PWA whose service worker keeps serving the cached shell after the proxy session expires. A review of `web/` against the `pwa-cloudflare` contract shows the detection and login path already exists (`/__access/probe` and `/__access/login` on the server, `web/src/utils/access.ts`, `AccessGate`, `ReloginOverlay`, SW `AUTH_EXPIRED`), but it is not specified anywhere and has gaps that leave the user on a dead app after an expiry. Those gaps are fixed here, and the behaviour is pinned down by a spec and tests so it does not regress.

## What Changes

Review findings (observed in the current code):

1. **Recovery after re-login does not restart live connections.** When `canConnect()` is false, `useWebSocket` and `useHistory` stop their reconnect loop and never resume it. The overlay's "I've signed in — retry" button only clears the overlay, so `/ws` and `/ws/events` stay dead until a manual reload.
2. **No bootstrap login-loop guard.** `AccessGate` navigates to the login entry every time the probe reports `needs-auth`. If the cookie cannot be set (blocked cookies, policy mismatch) the app and the login page bounce forever.
3. **Version check bypasses the gate.** `fetchServerVersion` swallows network errors and HTML replies as "no `/api/version`", logs a misleading "older copasrv" warning, and never re-probes.
4. **`useClipboard` bypasses the shared client.** It duplicates `CopaApi` and `push()` does not check for an HTML login response, so a 200 login page counts as a successful sync.
5. **Probe 404 is treated as `ready` without being documented**, and a non-redirect proxy rejection (401/403 on the probe) is reported as a generic `error` with a Retry button instead of offering sign-in. Needs to be confirmed against real Cloudflare behaviour for `fetch` with `Accept: application/json`.
6. **No automated tests** cover `access.ts`, the gate, or the SW classification. Only the Rust side (`src/server/access.rs`) has tests.

Changes:

- Add an access-restored signal. After the probe returns to `ready` following an expiry, the app re-establishes `/ws`, `/ws/events`, history and capabilities (reload is the fallback if a clean resume is not practical).
- Add a bootstrap loop guard: after one automatic login navigation within a short window, show a manual "Sign in" screen instead of navigating again.
- Route the version check through the access gate and treat HTML or a network error as a recheck trigger, not as "no version".
- Move `useClipboard` onto `CopaApi` so every REST call shares the HTML and failure detection.
- Classify a 401/403 on the probe as `needs-auth` (final mapping decided in design after checking real Access responses). Keep 404 as `ready` and document why.
- Add vitest to `web/` with tests for the probe classification, serialization, return-URL building, loop guard and resume behaviour.
- Document the supported topology and the Cloudflare Access policy requirements (`/__access/*` must be protected, not bypassed).

Out of scope (recorded assumptions):

- Cross-origin copa servers (the app on static hosting pointing at a server on another origin) cannot be probed with the current permissive CORS (no credentials). The app keeps skipping the gate for them and the limitation is documented.
- The embeddable widget (`web-widget/`), the MQTT transport and presigned object-store URLs.
- Hosting the app under a sub-path. `sw.js` and the probe use root-absolute paths.

## Capabilities

### New Capabilities
- `web-access-session`: how the web app detects a missing or expired identity-proxy session, gates protected networking on it, offers sign-in, and resumes after re-login.

### Modified Capabilities
<!-- none: existing web-client requirements (files, history) do not change -->

## Impact

- Code: `web/src/utils/access.ts`, `web/src/components/AccessGate.tsx`, `web/src/hooks/useWebSocket.ts`, `web/src/hooks/useHistory.ts`, `web/src/hooks/useClipboard.ts`, `web/src/hooks/useServerVersion.ts`, `web/src/utils/version.ts`, `web/src/hooks/useCapabilities.ts`. `web/public/sw.js` was reviewed and conforms; it is not changed.
- Tooling: `web/package.json` gains vitest (via `yarn`) and a `test` script.
- Server: no change expected. `src/server/access.rs` already implements the contract.
- Docs/deploy: README or `docs/` note on Access policy requirements; `CHANGELOG.md` entry.
- Packaging: `web/dist` rebuilt through `make dist`.
