# Verification: every spec scenario and where it is checked

Test locations (all paths relative to the `copa/` repository):

| Short name | What it is | Run with |
|---|---|---|
| **W** | `web-widget/test/*.test.ts(x)` — unit/component tests (jsdom or node); some start the real `token-issuer` or the real `copasrv` binary | `cd web-widget && yarn test` |
| **B** | `web-widget/test-browser/run.mjs` — real Chromium, style isolation and theming | `yarn test:browser` |
| **E-oauth** | `test-browser/e2e-oauth.mjs` — real Chromium + real `copasrv` + real `token-issuer` | `yarn test:e2e` |
| **E-pair** | `test-browser/e2e-pairing.mjs` — real Chromium + real `copasrv` + real `copacli pair` | `yarn test:e2e:pairing` |
| **E-all** | `test-browser/e2e-all.mjs` — every method on one page through real Garage S3 | `yarn test:e2e:all` (after `make dist`, `make s3-up`) |
| **E-dist** | `test-browser/dist-smoke.mjs` — the built distribution served by `copasrv --static-dir` | `yarn test:dist` (after `make dist`) |
| **R-issuers** | `tests/server_issuers.rs` (+ unit tests in `src/server/{issuers,jwks}.rs`) | `cargo test` |
| **R-auth** | `tests/server_auth.rs` (+ `src/server/token.rs` unit tests) | `cargo test` |
| **R-pair** | `tests/server_pair.rs`, `tests/server_pair_logs.rs` (+ `src/server/{pairing,pair_crypto}.rs`) | `cargo test` |
| **I** | `token-issuer/tests/` — the independent token service's own contract tests | `make test-token-issuer` |
| **X** | `token-issuer/dev/copasrv_e2e.py` — copasrv trusting the issuer, every fault switch | `uv run python dev/copasrv_e2e.py` |

## embeddable-widget

| Scenario | Checked by |
|---|---|
| Mounted from a module | W `share.test.tsx` "connects with the configured endpoint, namespace and token" |
| Mounted from a script tag | W `element.test.ts` "Copa.mount"; E-dist; E-oauth/E-pair (pages load `copa-widget.iife.js`) |
| Cross-origin host | E-oauth, E-pair (host page `localhost:N`, server `127.0.0.1:M`); E-all with Garage CORS for uploads |
| Host CSS does not break layout | B "host button/input styles do not alter the widget" |
| Host sets theme variables | B "the host sets the accent colour through a CSS custom property", "…dark scheme too" |
| Push text | W `share.test.tsx` "pushes text and shows success"; E-oauth, E-pair, E-all |
| Read-only credential | W `share.test.tsx` "read-only credential: no push control, pull still works"; E-oauth ("bob is read-only") |
| Text too large | W `share.test.tsx` "text over the namespace limit, with files unavailable…", `host-api.test.tsx` |
| Image preview | W `share.test.tsx` "image items show a thumbnail…"; E-all (thumbnail decoded from a Garage presigned URL) |
| HTML is inert | W `share.test.tsx` "HTML text is displayed as text and no script runs" |
| Pasted URL | W `share.test.tsx` "a single URL becomes a link that opens safely", "a javascript: URL is never linked" |
| Small text uses clipboard endpoint | W `host-api.test.tsx` "small text goes to the clipboard endpoint, no file upload" |
| File upload | W `share.test.tsx` "drop uploads with progress…"; E-oauth/E-pair/E-all (bytes verified in the object store) |
| Files not supported | W `share.test.tsx` "files unsupported: no file controls…" |
| File too large | W `share.test.tsx` "a file over max_file_size shows the limit and requests no upload" |
| Host shares data | W `host-api.test.tsx` "share(Blob) uploads a file item…" |
| Not authenticated | W `host-api.test.tsx` "rejects with a typed auth error…"; `oauth2-ui`, `pairing-ui` |
| Item from another device | W `live.test.tsx` "an item added by another client appears…"; E-oauth, E-all |
| Delete item | W `share.test.tsx` "a writer deletes an item…" |

## widget-connection-config

| Scenario | Checked by |
|---|---|
| Minimal config / Multiple endpoints | W `config.test.ts`; `share.test.tsx` "switching endpoints is remembered per browser" |
| No provider secrets in widget config | W `config.test.ts` "identity-provider secrets are rejected with an explanation" |
| Unknown method | W `config.test.ts` |
| Missing token service / Insecure token service URL | W `config.test.ts`, `schema-parity.test.ts` |
| Insecure URL / Loopback allowed / Newer version | W `config.test.ts` |
| Host-provided token | W `auth-static.test.ts` "host-provided token (tokenFrom)"; `share.test.tsx` |
| No token in URL | W `oauth2-login.test.ts` "never puts a token in a URL"; `oauth2-redirect.test.ts`. **Noted exception:** against a copasrv *without* event tickets, a static token is passed as `?token=` on the WebSocket upgrade (browsers cannot set headers there). Every server from this change has tickets, which the widget prefers (`live.test.tsx`, E-oauth, E-pair). |
| Syntax error (and the other load failures) | W `load.test.tsx` |

## token-service-login

| Scenario | Checked by |
|---|---|
| Successful popup login | W `oauth2-login.test.ts`; E-oauth; E-all |
| User closes popup | W `oauth2-login.test.ts`; E-oauth "closing the pop-up without signing in is a cancellation" |
| Popup blocked | W `oauth2-login.test.ts`, `oauth2-ui.test.tsx`; E-oauth "a blocked pop-up is explained…" |
| Discovery | W `oauth2-login.test.ts` "refuses a discovery document…", "works with explicit endpoint URLs…"; I `test_keys.py` |
| Audience requested | W `oauth2-login.test.ts` "uses an explicit audience…"; E-oauth (default audience = server origin) |
| Code stolen or replayed | I `test_contract.py` (replay, wrong verifier, expiry); W `oauth2-redirect.test.ts` "the code is useless without the stored verifier" |
| Message to the opener only | W `oauth2-login.test.ts` "ignores messages from other origins and other windows"; I `test_contract.py` "result page posts only to the recorded origin" |
| Opener link severed | W `oauth2-login.test.ts` (poll fallback, detached signal); E-oauth "a pop-up whose opener was cut (COOP)" in real Chromium |
| Silent renewal | W `oauth2-lifecycle.test.ts`; E-oauth "the access token is renewed silently when it expires" |
| Refresh token expired | W `oauth2-lifecycle.test.ts`; E-oauth "when the refresh token expires too…" |
| Default storage / Session persistence | W `oauth2-lifecycle.test.ts`; E-oauth "a session persisted for the tab survives a reload" |
| User signs out | W `oauth2-lifecycle.test.ts`, `oauth2-ui.test.tsx`; E-oauth |
| Valid token | R-issuers "a valid es256 token is accepted and mapped", "…rs256…"; X |
| Expired, foreign or untrusted | R-issuers (expired/leeway, audience, issuer, kid, signature, tamper); E-oauth (each rejected with a clear message) |
| Algorithm confusion | R-issuers "alg_none…", "the hs256 public key confusion attack…", "algorithm outside the allow-list"; startup refusal tests; X |
| Several issuers | R-issuers "two issuers are checked independently" |
| Static token still works | R-issuers "static tokens keep working next to issuers"; R-auth |
| Key set unavailable | R-issuers "a failing jwks keeps cached keys working", "…down at first use recovers"; `jwks.rs` unit tests; X |
| Reader group / Scope claim / Unmapped namespace | R-issuers (group, scope, glob, union, 403 on every endpoint); `issuers.rs` unit tests; E-oauth (carol → 403 message) |
| Ticket used once | R-auth "a ticket opens the stream once", expiry, namespace binding |
| Token expires on open stream | R-auth "the stream ends when the device credential expires"; R-issuers "…jwt ticket ends when the token expires"; W `live.test.tsx` reconnect |

## device-pairing

| Scenario | Checked by |
|---|---|
| Pairing disabled | R-pair "everything is 404 when pairing is disabled" (and for the exchange endpoints) |
| Window opened | R-pair "a writer opens a window and gets a code", "only writers may open windows" |
| Window expired | R-pair "the server answers a decoy…expired"; `pairing.rs` "windows expire"; "a pending pairing expires with its window" |
| Correct code | R-pair "the right code pairs a device…"; W `pairing.test.ts` (JS client against real server); E-pair; E-all |
| Wrong code | R-pair "a wrong code gets nothing"; W `pairing.test.ts`; E-pair |
| Attempt limit | R-pair "five wrong codes close the window…"; W `pairing.test.ts` |
| Fingerprints match | R-pair "the operator sees the same fingerprint…"; W `pairing.test.ts`, `pairing-ui.test.tsx`; E-pair; E-all |
| Operator rejects | R-pair "a rejected pairing gets denied…"; W; E-pair |
| Man in the middle | R-pair "a man in the middle shows up as a fingerprint mismatch"; W `pairing.test.ts` |
| Use credential | R-pair (token works on the namespace, bound to it, access level honoured); E-pair; E-all |
| Expiry | R-auth/R-pair; `token.rs` unit tests; W `pairing.test.ts`, `pairing-ui.test.tsx` ("goes back to pairing and tells the host") |
| Revocation | R-pair "revoking a device cuts it off…" and via `copacli`; W; E-pair "revoking the device with the CLI unpairs the browser" |
| Restart | R-pair "after a restart device credentials still work and open windows are gone"; `token.rs` restart test |
| Flood of requests | R-pair "a flood from one source is answered with 429 and Retry-After" (limit configurable) |
| Logs | R-pair `server_pair_logs.rs` (real binary, captured stderr); E-pair, E-all (no credential in the log) |

## Beyond the scenarios

Key-schedule parity between the Rust server and the JavaScript client is pinned by shared vectors
(`tests/pair_vectors.rs` ↔ `web-widget/test/vectors.test.ts`, `pair_crypto.rs` fingerprint vector) and exercised
live by `pairing.test.ts` against the real binary. Bundle budgets: `yarn size`.
