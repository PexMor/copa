# Design

## Context

- `web/` is a Vite + Preact app. Its API layer (`web/src/utils/api.ts`) and upload flow (`web/src/hooks/useFileUpload.ts`: `POST /api/files` → XHR `PUT` to the presigned URL → `POST /api/files/:id/complete`) already work and are reusable. Everything there assumes a `CopaServer { url, token }` and `Authorization: Bearer`.
- copasrv authorization (`src/server/auth.rs`) is a constant-time compare of the bearer against per-namespace `read_token` / `write_token` / `rw_token`. There is no notion of identity, expiry or revocation.
- Browsers cannot set headers on a WebSocket upgrade; `src/server/ws.rs` therefore accepts `?token=` for `/ws` and `/ws/events`. A long-lived static token in a URL is tolerable today; a short-lived access token or device credential is not.
- File bytes never pass through copasrv (presigned URLs, `rusty-s3`); the bucket needs CORS for every host origin that embeds the widget (`docs/FILES.md`).
- Motivation and scope: see `proposal.md`; requirements: see `specs/`.

## Goals / Non-Goals

**Goals:**
- One config-driven component that hides auth differences behind a single `getHeader()` seam, so the clipboard/file/history code is auth-agnostic.
- Keep the Rust change additive: trusted-issuer JWT verification and a pairing module with its own small token format; no behaviour change for existing static tokens.
- Keep copasrv free of OAuth client secrets and refresh tokens: it only verifies tokens, so one token service can serve many applications.
- Small bundle (target < 60 kB gzipped excluding the optional pairing chunk, which loads lazily; the token-service client is only a popup opener plus a few fetch calls).

**Non-Goals:**
- Implementing a production token service or OAuth client inside copasrv (only a mock for tests).
- Replacing the standalone `web/` app (it may adopt the shared core later).
- Content encryption end to end (the MQTT mode's AES-GCM is unrelated).

## Decisions

### D1. Separate `web-widget/` package with a shared core, not a mode of `web/`
A Vite **library build** (ES module + IIFE for script tags) in `web-widget/`, importing the API/upload code from a `core/` folder that `web/` can later consume. Alternatives: build the widget inside `web/` (couples release, brings MQTT/QR/PWA baggage into host pages) or fork the code (drift). Package manager: `yarn` (project convention), `preact` as a peer dependency, with `preact/compat` aliasing documented for React hosts.

### D2. Style isolation via Shadow DOM
The custom element `<copa-share>` mounts the Preact tree into a shadow root with styles inlined; the Preact component entry point is the same tree rendered into a host-provided node. Theming is by CSS custom properties (they cross the shadow boundary). Alternative: CSS-module prefixing only — rejected, host resets such as `button {}` still leak in for the non-shadow case; the component export is documented as "unisolated, you own the CSS".

### D3. Auth provider interface
```ts
interface AuthProvider {
  method: 'static-token' | 'oauth2' | 'pairing';
  state(): 'signed-out' | 'pending' | 'ready' | 'expired';
  getHeader(): Promise<string>;      // "Bearer …", renews if needed
  signIn?(): Promise<void>;          // oauth2 / pairing
  signOut(): Promise<void>;
  onChange(cb): () => void;
}
```
`ApiClient` takes a provider; on 401 it calls `provider.refresh()` once and retries. Three implementations; `pairing` is lazy-loaded (`import()`), so static-token and oauth2 embedders pay nothing for it.

### D4. JSON configuration and schema
`copa-widget.json` with `version: 1`, `endpoints[]`, validated at load by a JSON Schema (`web-widget/schema/copa-widget.schema.json`, published with the package) using a tiny hand-written validator for the runtime (no Ajv, size) and Ajv only in tests/CI to prove the validator and schema agree. The widget config names a *token service*; identity-provider client ids and secrets live only in the token service. Example:
```json
{
  "version": 1,
  "defaultEndpoint": "work",
  "endpoints": [
    { "id": "work", "url": "https://copa.example.com", "namespace": "team",
      "auth": { "method": "oauth2", "tokenService": "https://auth.example.com",
                "audience": "https://copa.example.com", "persist": "memory" } },
    { "id": "lan", "url": "http://127.0.0.1:8080",
      "auth": { "method": "pairing", "protocol": "spake2" } }
  ]
}
```
Loaded from `configUrl`, an object prop, or `<script type="application/json" id="copa-config">`.

### D5. Popup login against an external token service
The token service (any app, e.g. a central "auth hub" used by many applications) owns the IdP relationship: client registration, client secret, code exchange, user/consent UI, and refresh tokens. copasrv and the widget only follow a small contract.

```
widget                         token service                    IdP (Google/OIDC)
  │ verifier = random; challenge = S256(verifier)
  │ window.open(loginUrl?audience=A&origin=O&challenge=C)   ← inside the click handler
  ├────────────────────────────▶│ check O against the service's per-application allow-list
  │                             ├──────── standard OAuth2/OIDC authorization-code flow
  │                             │◀──────── callback to the token service (its own redirect URI)
  │◀── popup page: opener.postMessage({type:'copa-login', login_code}, O); window.close()
  │     (fallback when opener is severed: POST pollUrl {verifier} → login_code — the verifier, not a login id, is the handle)
  │ POST tokenUrl {login_code, verifier}
  │◀── {access_token, access_expires_at, refresh_token, refresh_expires_at}
  │ ...later: POST refreshUrl {refresh_token} → rotated pair;  POST logoutUrl {refresh_token}
  │ Authorization: Bearer <access_token> ───▶ copasrv (verifies, never contacts the token service)
```
- **Contract**: `loginUrl`, `pollUrl`, `tokenUrl`, `refreshUrl`, `logoutUrl`, discoverable from `<base>/.well-known/copa-token-service` (JSON with those URLs, `issuer`, `jwks_uri`). The widget config gives the base URL or the individual URLs. `audience` identifies the copa server (default: the endpoint URL's origin).
- **Binding**: tokens are released only for the `verifier` behind the challenge; the single-use login code (≤ 60 s) is the only value crossing the popup boundary. `postMessage` targets the recorded origin (never `*`), and the widget accepts messages only from the token service origin. The poll path is a first-class fallback for IdPs that sever `window.opener` (COOP).
- **Access token format**: a signed JWT (RS256/ES256/EdDSA) with `iss`, `aud` (copa server), `sub`, `iat`, `exp`, and permission claims the operator maps (`scope` such as `copa:team:rw`, or `groups`/`email`/`roles`). "Custom structure" lives in these claims; copa only requires `iss`, `aud`, `exp`, and a claim it can map. Lifetime is the token service's choice; copa documents 5–15 minutes as the recommended range because there is no instant revocation.
- **Redirect-mode fallback**: for popup-hostile environments the login page can return to the host page with the login code in the URL fragment, with the same verifier binding. Documented, implemented after the popup path.
- **Independent test token issuer** (`token-issuer/`, built early, see tasks group 4): a standalone process with its own dependencies (Python managed by `uv`), no code shared with copasrv, so it exercises the contract exactly as a third-party service would. It generates an ES256 key pair, publishes `/.well-known/copa-token-service` and a JWKS, serves the popup login page with a configurable list of fake users (each with `sub`, `email`, `groups`, `scope`), and implements login/poll/token/refresh/logout with verifier binding, single-use codes, per-application origin allow-list and refresh rotation with reuse detection. Fault-injection switches (query/config flags) produce tokens that are expired, have a wrong `aud` or unknown `kid`, use `alg: none` or HS256, short TTLs, key rotation, and a `Cross-Origin-Opener-Policy: same-origin` login page. An optional upstream mode can delegate to a real OIDC provider (dex/Keycloak) for end-to-end checks. It is a test and demo tool, not a product, and is not shipped in `bin/`.

Alternatives considered: copasrv as OAuth client and token issuer (rejected after review — duplicates a token service most deployments already have or want to share across apps, puts client secrets and refresh storage in copasrv); the widget doing PKCE directly against the IdP (rejected — IdP tokens would be bearers, no custom claims, secrets/public-client limits); implicit flow (deprecated).

### D6. Trusted-issuer JWT verification in copasrv
New `[server.auth.issuers.<name>]` sections:
```toml
[server.auth.issuers.hub]
iss         = "https://auth.example.com"
jwks_url    = "https://auth.example.com/.well-known/jwks.json"
audience    = "https://copa.example.com"
algorithms  = ["ES256", "RS256"]
leeway_secs = 30
[[server.auth.issuers.hub.map]]
claim = "scope"; value = "copa:team:rw"; namespace = "team"; access = "rw"
[[server.auth.issuers.hub.map]]
claim = "groups"; value = "copa-readers"; namespace = "team"; access = "r"
```
`authorize()` becomes: static compare first (unchanged cost), else a bearer with the JWT shape → select the issuer by unverified `iss` (lookup only, never trusted) → verify with `jsonwebtoken` (algorithm allow-list per issuer, `iss`/`aud`/`exp`/`nbf`, `jku`/`x5u`/embedded keys ignored) → claim map → `(namespace, Access)`; else a pairing device token (D8). JWKS: fetched with `ureq` on a blocking task, cached with TTL, refreshed on unknown `kid` with a minimum interval, stale keys kept on fetch failure. Copa tokens (`v1.`) and JWTs are told apart by shape. Alternatives: opaque token introspection (per-request call to the service, hurts availability), shared HMAC secret with the token service (no key separation between services) — JWKS with asymmetric keys is the default; HS256 is not allowed.
- **Pairing-only token module** (`token.rs`): signing secret (generated into `~/.local/state/copa/auth.json`, `0600`, `COPA_TOKEN_SECRET` override) and `v1.<payload>.<mac>` device tokens with revocation by device id (used only by D8). Sessions, refresh tokens and OAuth state do not exist in copasrv.

### D7. WebSocket credentials via short-lived tickets
`POST /api/events/ticket` (normal Bearer auth) returns a random single-use ticket valid for 30 s bound to namespace + access + the credential's expiry; `/ws/events?ticket=…` consumes it. The existing `?token=` path stays for static tokens and the legacy UI. The server closes the socket at credential expiry. Alternative: first-message auth frame — also fine but changes the protocol of existing clients; tickets are additive.

### D8. Pairing protocol
Endpoints (all under `/api/pair/`, JSON, disabled unless `[server.pairing] enabled = true`):
- `POST /api/pair/windows` (authorized, write-capable credential or a local admin token): opens a window → `{window_id, code, expires_at, scope}`. `copacli pair open` is the operator UI (prints code, QR with the server URL, lists/revokes devices; `GET /api/pair/devices`, `DELETE /api/pair/devices/:id`).
- SPAKE2 (`spake2` crate, Ed25519 group, identities `copa-widget` / `copa-server`): `POST /api/pair/spake2/start {window_id, msg}` → `{session_id, msg}`; `POST /api/pair/spake2/confirm {session_id, mac}` → `{mac, credential, expires_at}`. Confirmation MACs are HMAC-SHA256 over the transcript with keys from HKDF of the SPAKE2 key; the server verifies the client MAC **before** releasing the credential and the credential is delivered AEAD-encrypted under the derived key, so a passive observer or active guesser learns nothing without the code. The code is 8 digits (≈ 26 bits) — acceptable because online guessing is capped at 5 attempts per window and the window lives 120 s; SPAKE2 prevents offline attack.
- ECDH (P-256 via WebCrypto in the browser, `p256` on the server): `POST /api/pair/ecdh/start {window_id, pub}` → `{session_id, pub, fingerprint}`; the operator sees the same fingerprint (truncated SHA-256 of both public keys + window id, rendered as 6 words or 4 groups of digits) through `copacli pair pending` / `pair approve <id>`; `GET /api/pair/ecdh/:session_id` (polled with a nonce proof) returns the AEAD-wrapped credential once approved. QR variant: the widget shows its public key as a QR the operator scans, which counts as approval.
- Credential: a copa `v1.` device token from the pairing-only token module of D6, with a device id and a lifetime of `device_ttl_secs` (default 24 h); renewal means pairing again unless the operator enables sliding renewal (a re-issue request authorized by a still-valid device token). Revocation is per device via the revocation list in `auth.json`.

Because every method ends in "a bearer value", the widget treats a pairing result like any other token afterwards (`getHeader()` returns it, in memory/storage per config).

### D9. Content-type awareness lives in one pure module
`classify(item | Blob | string) → {kind, mime, previewable}` — MIME from `File.type`/`content_type`, falling back to magic-byte sniffing (png/jpeg/gif/webp/pdf) and text heuristics (single URL, JSON that parses, HTML tags). Rendering is a small per-kind switch; text is always rendered via text nodes, images via a blob/`<img>` from a fresh presigned URL (never persisted). Routing rule (spec "Route payloads"): text ≤ `size_limit` → `/api/clipboard`; everything else → file flow. The server stores the declared `content_type` as metadata only (objects are `octet-stream`), so the widget never trusts it for rendering decisions beyond previews, and `<img>` is the only embedded media.

### D10. Host API
The component exposes a ref/handle `{share, paste, signIn, signOut}`; the custom element mirrors it as methods plus DOM events (`copa:item`, `copa:auth`, `copa:error`). Calls while unauthenticated reject with `CopaAuthError` and open the sign-in UI.

## Risks / Trade-offs

- [Static token in a public JSON file is world-readable] → documented loudly; schema marks it `x-sensitive`; `tokenFrom`, token-service login and pairing are the recommended modes; dev-only warning logged when a token is found over a non-loopback page.
- [Pairing code is low-entropy] → SPAKE2 (no offline guessing), 5-attempt cap, 120 s window, rate limiting; the ECDH mode adds human verification.
- [Trusting the wrong issuer or audience] → explicit per-issuer `iss`/`aud`/algorithm allow-list, issuer chosen by exact configured match, tokens for other audiences rejected; the operator must configure a distinct audience per copa server.
- [No instant revocation of access tokens] → short lifetimes recommended (5–15 min), refresh revocation happens at the token service; optional denylist/introspection deferred (not in this change).
- [Token service unavailable] → already issued access tokens keep working until expiry and copasrv uses cached keys; only sign-in and renewal fail, and the widget shows a clear signed-out/offline state.
- [Popup blocked] → open in the click handler, detect `null`/closed popup, show a retry message, offer the redirect-mode fallback.
- [IdP or token service sends COOP and severs `window.opener`] → the poll endpoint with the widget verifier is a first-class path; tested with a mock service that sends `Cross-Origin-Opener-Policy: same-origin`.
- [Hostile page opens the popup / open redirect] → the token service must check `origin` against a per-application allow-list and use fixed redirect URIs; `postMessage` targets the recorded origin; results are redeemable only with the widget verifier. These obligations are part of the contract documentation.
- [Refresh token theft] → memory storage by default; rotation and reuse detection are the token service's duty and listed in the contract; `local` persistence is opt-in and documented as weaker.
- [JWT validation bugs are security bugs] → `jsonwebtoken` with explicit algorithm allow-list, reject `none` and HMAC, `jku`/`x5u` ignored, unverified `iss` used only for lookup; tests for confusion cases.
- [JWKS fetch becomes an availability/DoS vector] → cache with TTL, serve stale on fetch failure, rate-limit refresh on unknown `kid`.
- [Signing secret for pairing lost or leaked] → generated per host with `0600`, env override, rotation invalidates device tokens; documented.
- [S3 CORS must list each host origin] → documented; the existing CORS hint from `useFileUpload` is reused so the failure is diagnosable.
- [Shadow DOM breaks some host CSS-in-JS/focus tooling and form autofill] → acceptable; component export remains for non-isolated use.
- [Scope is large (client + server + token-service contract + two key exchanges)] → delivered in ordered, independently shippable groups (see tasks); static-token widget is usable after group 3, token-service login after group 7.

## Migration Plan

Additive. Existing configs and clients are untouched; `[server.auth.issuers.*]` and `[server.pairing]` absent ⇒ behaviour identical to today and no state file is created. New dependencies are added to `Cargo.toml` and `Cargo.lock` and covered by `make dist` cross-builds (check `armhf` builds for `p256`/`spake2`). Rollback: remove the config sections; the state file is ignored. Versions: bump copa minor in the submodule, document in `CHANGELOG.md`.

## Open Questions

- Package name/publishing target for the widget (npm scope vs. served as a static asset by copasrv at `/widget/`) — does not change specs; default is a built `dist/` copied into `bin/frontend/` by `make dist`.
- Whether pairing windows may also be opened from the standalone web UI (initially CLI only).
