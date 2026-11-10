# Proposal

## Why

The copa web UI (`web/`) is a standalone app: its server list, token storage and clipboard/file panels are tied to that page. Teams who want "send this to my other device / paste buffer" inside their own web application have to re-implement the API client, auth and S3 upload flow. Authentication is also limited to a static bearer token pasted by hand, which is unsuitable for apps that already have an IdP (Google, OIDC, OAuth2) or for unknown devices that should be paired ad hoc.

## What Changes

- Add a reusable **`<CopaShare>` Preact component** (new package `web-widget/`, built as an ES module + a self-mounting script tag) that embeds copa clipboard access in any web application: push/pull text, content-type aware items, history list, and file upload/download through the existing presigned-S3 flow.
- Drive the widget from a **JSON configuration file** (`copa-widget.json`, JSON-Schema validated) that defines one or more endpoints (`url`, `namespace`) and, per endpoint, the **auth/pairing mechanism**:
  - `static-token` – fixed bearer token (inline, or supplied by the host app).
  - `oauth2` – "Sign in with …" **popup window** (Google-style) against a **central, external token service** that does the OAuth2/OIDC code exchange with the identity provider and issues a short-lived signed access token (JWT with copa claims) plus a long-lived refresh token. The token service is independent of copa and may serve many applications; the widget uses the access token as the bearer for all copa calls and renews it at the token service. The widget↔token-service contract (login popup, verifier-bound hand-off, token, refresh, logout) is specified so any service can implement it.
  - `pairing` – dynamic pairing via **SPAKE2** (short code) or **ECC (ECDH P-256) key exchange with QR/confirmation**, yielding a time-limited, revocable copa device token of the same format.
- **Content-type aware sharing**: the widget classifies items (plain text, URL, JSON, HTML, image, other file) from the MIME type/sniffing, renders suitable previews, and routes large/binary payloads through the file (S3) path while small text uses `/api/clipboard`.
- **Server side (copasrv)** gains what the non-static modes need: verification of JWTs from configured **trusted issuers** (JWKS, issuer/audience, claim → namespace/permission mapping) and the pairing endpoints that run SPAKE2/ECDH and issue copa's own small device tokens. copasrv never performs the OAuth code exchange and never sees refresh tokens. Static tokens keep working unchanged.
- Host-app integration API: props/events (`onItem`, `onAuthChange`), `copa.share(data|File)`, `copa.paste()`, theming via CSS variables, and an `tokenFrom` hook for host-provided tokens.

## Capabilities

### New Capabilities
- `embeddable-widget`: the `<CopaShare>` Preact component, mounting/embedding API, theming, events and the content-type aware text/file sharing UI.
- `widget-connection-config`: JSON configuration schema and loading rules (endpoints, auth method selection, validation, secrets handling, multiple endpoints).
- `token-service-login`: popup sign-in against an external token service (the contract), the widget's token lifecycle, and copasrv's verification of tokens from trusted issuers with claim-to-namespace mapping.
- `device-pairing`: SPAKE2 / ECC key-exchange pairing between a widget and copasrv that yields a time-limited, revocable device credential.

### Modified Capabilities
<!-- none: existing specs (file-transfer, web-client, clipboard-history) keep their requirements; the widget reuses /api/files and /api/history unchanged. Token authentication gets no existing spec, so its new behaviour is specified in token-service-login and device-pairing. -->

## Impact

- New: `token-issuer/` (independent test token service implementing the widget↔token-service contract, with fake users, JWKS, fault injection; used by tests and the demo, not shipped);
- New: `web-widget/` (Vite library build, Preact + TypeScript, JSON schema, demo host page, tests); shared API/file-upload code factored from `web/src/utils/api.ts` and `web/src/hooks/useFileUpload.ts` (reused, not forked, where practical).
- Modified (Rust): `src/server/auth.rs` (multi-credential authorization), `src/server/config.rs` (`[server.auth.issuers.<name>]`, `[server.pairing]`), `src/server/mod.rs` (routes `/api/pair/*`, `/api/events/ticket`); new `src/server/jwt.rs` (trusted-issuer JWT verification and JWKS cache), `src/server/token.rs` (pairing device tokens, signing secret, revocation), `src/server/pairing.rs`; new dependencies for JWT validation and SPAKE2 (e.g. `jsonwebtoken`, `spake2`, `p256`, HMAC).
- CORS: `allowed_origins` must list host applications (the token service additionally validates the popup opener origin); documented in `docs/`.
- Docs: `docs/WIDGET.md`, `config.toml.example`, README.
- Assumptions: the server-side auth additions are in scope (otherwise OAuth2/pairing could not work); the token service and identity provider are external and not provisioned or operated here (a minimal mock token service is built only for tests and the demo), and the operator registers copasrv as an audience and configures its issuer, key set URL and claim mapping; the widget talks to S3 only via presigned URLs from copasrv (no S3 credentials in the browser).
- Out of scope: copa acting as an OAuth2 client, authorization server or token service, instant revocation of already issued access tokens (short lifetimes instead), MQTT transport in the widget, native (non-web) embedding, end-to-end encryption of clipboard content, multipart upload for files above the existing `max_file_size`.
