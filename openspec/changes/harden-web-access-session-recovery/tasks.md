# Tasks

## 1. Test tooling

- [x] 1.1 In `web/`, run `yarn add -D vitest jsdom` and add a `"test": "vitest run"` script; verify `yarn test` runs (zero tests is fine) and `yarn build` still passes. Do not use `npm`.
- [x] 1.2 Add `web/vitest.config.ts` (jsdom environment, `__COPA_BUILD__` defined) and verify a trivial import of `src/utils/access.ts` works in a test.

## 2. Probe classification and access state (`web/src/utils/access.ts`)

- [x] 2.1 Map probe `401`/`403` to `needs-auth`, keep `404` → `ready`, and comment why both are safe (copa never authenticates the probe route). Verify with `web/src/utils/access.test.ts` covering 204+header, 204 without header, 302, opaqueredirect, 401, 403, 404, 500, thrown error online and offline.
- [x] 2.2 Add `accessEpoch` incremented only on an expired→ready transition, with `subscribeRestored` and a `useAccessEpoch` hook. Verify by a test that the epoch does not change on ready→ready or on offline/error results.
- [x] 2.3 Change `canConnect` to return `'ready' | 'needs-auth' | 'paused'` (`paused` for offline/error). Verify by test including that concurrent calls share one probe request.
- [x] 2.4 Add a test for `loginEntryUrl` with path, query and hash, checking that the hash survives encoding.

## 3. Bootstrap loop guard (`AccessGate`)

- [x] 3.1 Stamp `sessionStorage` (`copa.access.loginAt`, try/catch around every access) before the automatic login navigation; within 60 s of a stamp, show a manual "Sign in" button and an explanation instead of navigating; clear the stamp on `ready`. Verify with a unit test of the extracted guard function (stamp fresh, stamp stale, storage throwing).
- [x] 3.2 Render the manual screen state in `AccessGate` using existing `access-*` styles. Verify with `yarn build` (tsc) and a manual check noted in group 7.

## 4. Resume live connections after re-login

- [x] 4.1 `useWebSocket`: add the epoch to the effect dependencies; on `canConnect` result `paused`, schedule the normal 3 s retry; on `needs-auth`, stay idle. Verify with a test using a fake `WebSocket` that one restore creates exactly one new socket and that `needs-auth` schedules none.
- [x] 4.2 `useHistory`: same change for `/ws/events`, and refresh the list on restore. Verify with the same fake-socket test approach.
- [x] 4.3 `useCapabilities` and `useServerVersion`: re-run on epoch change. Verify with a test that a restore triggers one new request each.
- [x] 4.4 Make the overlay's "I've signed in — retry" button close the dialog only when the probe returns `ready` and keep it open with a short "still signed out" hint otherwise. Verify by test of `recheckAccess` outcomes and `yarn build`.

## 5. Login responses are never data

- [x] 5.1 Port `useClipboard` to `CopaApi` (`getClipboard`/`postClipboard` with `apiFor`), deleting the duplicated header and HTML helpers. Verify that `push()` with a 200 HTML response reports `error` and calls the recheck, by test with a mocked `fetch`.
- [x] 5.2 `fetchServerVersion`: separate "valid", "no endpoint" (404 or JSON without version fields) and "unexpected" (network error, HTML). Only "unexpected" calls `recheckAfterFailure`, and only "no endpoint" logs the older-copasrv warning. Verify with a test per outcome.

## 6. Documentation

- [x] 6.1 Add a "Behind an identity proxy" section to `README.md` (or `docs/`): protect `/__access/*` (no Bypass policy), serve app and API from one origin, cross-origin servers are not gated, and how to simulate expiry. Verify by reading the rendered section and checking the paths against `src/server/mod.rs`.
- [x] 6.2 Add a `CHANGELOG.md` entry and bump the version in `Cargo.toml` / `Cargo.lock` inside the `copa` submodule per the project rules. Verify `cargo check` passes.

## 7. Integration checks

- [x] 7.1 Run `yarn test`, `yarn build` in `web/`, and `cargo test` in `copa/`; all pass.
- [x] 7.2 Run `make dist` and confirm `bin/frontend/` contains the rebuilt app with an unchanged `sw.js`.
- [ ] 7.3 Hand the manual checklist to the user to run against the real Cloudflare tunnel (no Playwright, the user tests themselves): authenticated start (one probe, networking starts once); delete `CF_Authorization` then reload with the cached shell (redirected to sign-in, back on the same route); delete the cookie while the app is open then switch tabs (blocking dialog); sign in in another tab then press retry (sockets reconnect, no reload); offline launch (retry screen, no login); policy-denied user (manual sign-in screen, no loop); `//evil.com` as `return` lands on `/`; `/__access/*` absent from the SW cache.
