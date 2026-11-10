# Tasks

## 1. Widget package scaffold

- [x] 1.1 Create `web-widget/` (yarn project with its own `package.json` + `yarn.lock`, Vite library mode, Preact as peer dep, TypeScript strict); verify `yarn build` emits an ES module and an IIFE bundle
- [x] 1.2 Extract the API client and presigned-upload code from `web/src/utils/api.ts` / `web/src/hooks/useFileUpload.ts` into a shared `core/` used by the widget (auth via an injected `getHeader()`); verify `web` still builds (`yarn build` in `web/`) and existing upload behaviour is unchanged
- [x] 1.3 Add a demo host page (`web-widget/demo/index.html`) loading the widget from a script tag; verify it renders against a local `copasrv` started with `cargo run --bin copasrv`

## 2. Configuration loading and validation

- [x] 2.1 Write `copa-widget.schema.json` and a small runtime validator (https-or-loopback URLs, method-specific required keys for `static-token`/`oauth2`/`pairing`, `version` check, unknown-key warning, no identity-provider secrets in widget config); verify unit tests cover each scenario in `specs/widget-connection-config`
- [x] 2.2 Implement loading from `configUrl`, object prop and inline `<script type="application/json">`, with visible error states and `onError`; verify tests for network, HTTP status, JSON syntax and schema failures
- [x] 2.3 Add a test asserting the runtime validator and the JSON Schema (checked with Ajv in dev only) accept/reject the same fixtures; verify it passes in CI (`yarn test`)
- [x] 2.4 Document the config format and every `auth` option in `docs/WIDGET.md` with the sensitivity warning for inline tokens; verify the documented example validates against the schema

## 3. Widget UI, content-type handling and static-token auth

- [x] 3.1 Implement the `AuthProvider` interface and the `static-token` provider (inline token and `tokenFrom` host callback); verify unit tests for header output and 401 handling
- [x] 3.2 Implement `classify()` (MIME, magic-byte sniffing, URL/JSON/HTML text heuristics) as a pure module; verify table-driven unit tests per class including `<script>` text and non-URL strings
- [x] 3.3 Build `<CopaShare>`: text push/pull with `size_limit`, capability-driven file controls, drag/drop/paste/picker upload with progress, history list, delete, per-kind previews (text nodes only, image via fresh presigned URL); verify component tests with a mocked API for each requirement scenario in `specs/embeddable-widget`
- [x] 3.4 Implement routing (text ≤ limit → clipboard endpoint, else file flow) and the host API (`share`, `paste`, events, `CopaAuthError`); verify tests for `share(Blob)` and unauthenticated rejection
- [x] 3.5 Add the `<copa-share>` custom element with Shadow DOM, CSS-custom-property theming and light/dark/auto; verify a browser test that host `button` styles do not alter widget buttons and the accent variable applies
- [x] 3.6 Wire live updates: use `/ws/events` (via ticket when available) with reconnect and backoff, fall back to manual refresh; verify an integration test where a second client's upload appears without action
- [x] 3.7 Document embedding (module, script tag, CORS `allowed_origins`, bucket CORS) in `docs/WIDGET.md`; verify the demo page follows the documented steps

## 4. Independent test token issuer (`token-issuer/`)

- [x] 4.1 Create `token-issuer/` as a standalone Python project managed by `uv` (own `pyproject.toml`, console entry point, config via file/env/CLI, no code shared with copasrv); verify `uv run token-issuer --help` and starting it on a local port serving a health route
- [x] 4.2 Implement key management and publication: generate/persist an ES256 key pair, serve `/.well-known/copa-token-service` (endpoint URLs, `issuer`, `jwks_uri`) and a JWKS, support key rotation with overlapping keys; verify pytest checks that the discovery document matches the contract and that tokens verify against the published JWKS
- [x] 4.3 Implement access-token issuing as JWTs with configurable `iss`, `aud`, `sub`, `scope`, `groups`, `email` and TTL, driven by a users file (`users.example.json` tracked); verify tests decode issued tokens and check every claim and expiry
- [x] 4.4 Implement the popup login page (fake user picker, optional password) and the contract endpoints: login, poll, token, refresh (rotation + reuse revokes the session), logout, per-application origin allow-list, single-use 60 s login codes bound to the verifier challenge, `postMessage` only to the recorded origin; verify pytest contract tests for each scenario in `specs/token-service-login` (wrong verifier, replay, expired code, disallowed origin, reuse of refresh token, logout)
- [x] 4.5 Add fault-injection switches (expired token, wrong `aud`, unknown `kid`, `alg: none`, HS256 with the public key as secret, very short TTL, login page with `Cross-Origin-Opener-Policy: same-origin`, slow/failed JWKS); verify each switch produces the documented token or behaviour in tests
- [x] 4.6 Add an optional upstream mode delegating login to a real OIDC provider (dex container in `token-issuer/dev/`); verify the documented script performs a login against dex and issues a token with mapped claims
- [x] 4.7 Write `token-issuer/README.md` (contract, flags, fault switches, how copasrv and the demo use it) and a `make token-issuer` target; verify the README quickstart works as written

## 5. Server: pairing token module and multi-credential authorization

- [x] 5.1 Add `src/server/token.rs`: signing secret (generated into `auth.json` `0600`, `COPA_TOKEN_SECRET` override), `v1.` device-token issue/verify and per-device revocation list; verify unit tests for round trip, tampered payload, wrong secret, expiry, revocation and restart persistence
- [x] 5.2 Refactor `src/server/auth.rs` so `authorize()` resolves a credential to `(namespace, Access)` via pluggable sources (static first, unchanged; then trusted-issuer JWT; then `v1.` device tokens, told apart by shape); verify existing `auth.rs` tests still pass and `cargo test` is green
- [x] 5.3 Add `POST /api/events/ticket` (single-use, 30 s, bound to namespace/access/credential expiry) and ticket support on `/ws/events` including close-at-expiry; verify tests: ticket works once, expires, is refused for read-less credentials, stream closes at expiry
- [x] 5.4 Document tokens, tickets and the retained `?token=` path in `docs/WIDGET.md` and `config.toml.example`; verify the example config still parses (`cargo test`)

## 6. Server: trusted-issuer JWT verification

- [x] 6.1 Add `[server.auth.issuers.<name>]` config parsing (`iss`, `jwks_url`, `audience`, `algorithms`, `leeway_secs`, claim map) with startup validation, clear errors and no HMAC algorithms; verify config tests for missing/invalid keys
- [x] 6.2 Implement JWT verification with `jsonwebtoken` (per-issuer algorithm allow-list, `iss`/`aud`/`exp`/`nbf`, `jku`/`x5u`/embedded keys ignored, unverified `iss` used only to select the issuer); verify tests with locally generated keys for valid, expired, wrong audience, unknown issuer, unknown key, `alg: none` and HS-confusion tokens
- [x] 6.3 Implement the cached JWKS (TTL, refresh on unknown `kid` with minimum interval, stale-on-failure) with `ureq` on a blocking task; verify tests against the `token-issuer` fixture: key rotation picks up the new key, a failing JWKS keeps cached keys working, a flood of unknown `kid` causes at most one refresh per interval
- [x] 6.4 Implement claim → namespace/access mapping (scope, groups, email, subject) and integrate with `authorize()` for clipboard, history, files and tickets (403 when unmapped, several issuers); verify tests for reader, writer, scope claim, unmapped namespace and two issuers
- [x] 6.5 Ensure no token or presigned URL appears in logs on failures; verify with a test capturing log output
- [x] 6.6 Document trusting an issuer (token-issuer example, audience, claim maps) in `docs/WIDGET.md` and `config.toml.example`; verify the examples parse and a copasrv started with them accepts a token from `token-issuer`

## 7. Widget: token-service client

- [x] 7.1 Implement the `oauth2` provider: discovery, `verifier`/challenge, synchronous `window.open` from the click, origin-checked `postMessage` listener, poll fallback, token exchange, popup-closed detection, popup-blocked message; verify unit tests with a fake popup and the `token-issuer` for success, cancel, blocked popup and severed opener
- [x] 7.2 Implement the token lifecycle: renewal before expiry (<60 s) and once after a 401 via the refresh endpoint, rotated refresh-token handling, `memory`/`session`/`local` persistence with restore on reload, sign-out via the logout endpoint, signed-out state and `onAuthChange` on failure; verify tests for each lifecycle scenario in `specs/token-service-login`
- [x] 7.3 Add sign-in/out UI and the redirect-mode fallback (login code in the URL fragment, same verifier binding); verify the static-token bundle size is unaffected (size check script in CI)
- [x] 7.4 End-to-end against real `copasrv` (trusting `token-issuer`) in a browser: popup login, push text, upload file, access-token expiry with silent refresh, sign-out, expired refresh, COOP login page (poll fallback), wrong-audience and unknown-`kid` tokens rejected with a clear message; verify the documented run script passes in CI

## 8. Server: pairing

- [x] 8.1 Add `[server.pairing]` config and device records on top of the group 5 token module (per-device revocation, optional sliding renewal); verify tests for round trip, expiry, per-device revocation and restart persistence
- [x] 8.2 Implement pairing windows (`POST /api/pair/windows`, one-time code, expiry, attempt cap, rate limiting, bounded pending sessions); verify tests for disabled → 404, expiry, five-attempt close and 429
- [x] 8.3 Implement the SPAKE2 endpoints with mutual key confirmation and AEAD-wrapped credential delivery; verify tests with a Rust SPAKE2 test client: correct code, wrong code, replay, tampered confirmation
- [x] 8.4 Implement the ECDH endpoints (P-256, transcript fingerprint, operator approval, QR-approval path); verify tests for approve, reject and a substituted-key mismatch
- [x] 8.5 Add `copacli pair open|pending|approve|reject|devices|revoke`; verify an integration test drives a full pairing and revocation via the CLI
- [x] 8.6 Verify logs exclude codes, keys and credentials and responses do not reveal code existence; document the operator flow in `docs/WIDGET.md`; confirm `make dist` cross-builds (including `armhf`) with the new crates

## 9. Widget: pairing client

- [x] 9.1 Implement the SPAKE2 client (WebCrypto/`@noble` primitives matching the server's group and transcript) with a code-entry UI; verify cross-implementation tests against fixed vectors produced by the Rust side
- [x] 9.2 Implement the ECDH client (WebCrypto P-256, fingerprint display, QR of the public key, polling with nonce proof); verify tests for approval, denial and timeout
- [x] 9.3 Handle credential expiry/revocation (return to unpaired state, offer re-pair, `onAuthChange`); verify a test where the server revokes a device mid-session
- [x] 9.4 Add browser end-to-end tests for both pairing modes against a real `copasrv` (open window via CLI, pair in the widget, push text, upload file); verify they pass in CI

## 10. Integration and release

- [x] 10.1 Wire `web-widget` into `make dist` (output to `bin/frontend/widget/`) and `copasrv --static-dir` serving; verify `make dist` produces the files and the demo loads from the server
- [x] 10.2 Full cross-method run on the demo page (static token, token-service popup via `token-issuer`, SPAKE2, ECDH) with text, image and PDF sharing through Garage (`make s3-up`); verify all spec scenarios in `specs/` have a passing test or a recorded manual check
- [x] 10.3 Update `README.md`, `CHANGELOG.md` and bump the version in `Cargo.toml`/`Cargo.lock`; verify `cargo test`, `cargo build --release` and `yarn build` pass in both web packages

## Workflow follow-up

- Archive the change after the review requirements are satisfied.
- Commit inside the `copa/` submodule first, then the updated submodule pointer in the parent repo.
