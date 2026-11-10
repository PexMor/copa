# Embeddable widget

The copa widget (`web-widget/`) is a Preact component that lets any web
application share text and files through a copa server. It is configured by a
single JSON document that lists the copa endpoints and how to authenticate with
each of them.

> **Status:** work in progress (change `add-embeddable-copa-widget`). The
> configuration format below is implemented and validated; the sign-in methods
> `oauth2` and `pairing` are described here ahead of their implementation.

- [Embedding](#embedding)
- [Configuration file](#configuration-file)
- [Endpoints](#endpoints)
- [Authentication methods](#authentication-methods)
- [The token-service contract](#the-token-service-contract)
- [Validation and loading](#validation-and-loading)
- [Secrets](#secrets)
- [Host API](#host-api)
- [Theming](#theming)
- [Cross-origin setup (CORS)](#cross-origin-setup-cors)
- [Server: tokens and event tickets](#server-tokens-and-event-tickets)
- [Trusting a token service](#trusting-a-token-service)
- [Pairing devices](#pairing-devices)

## Embedding

Build the widget once:

```bash
cd web-widget
yarn install
yarn build        # dist/copa-widget.es.js (ES module) and dist/copa-widget.iife.js (script tag)
```

### Script tag (no build step)

The self-contained `copa-widget.iife.js` registers the `<copa-share>` element and
a global `Copa`:

```html
<script src="copa-widget.iife.js"></script>

<!-- configuration from a URL ... -->
<copa-share config-url="/copa-widget.json"></copa-share>

<!-- ... or inline -->
<copa-share>
  <script type="application/json">
    { "version": 1, "endpoints": [ { "id": "lan", "url": "http://127.0.0.1:8080",
      "auth": { "method": "static-token", "token": "…" } } ] }
  </script>
</copa-share>

<!-- ... or from script, anywhere on the page -->
<script>
  const mounted = Copa.mount(document.getElementById('box'), { configUrl: '/copa-widget.json' });
  const copa = await mounted.ready;        // host API, see below
</script>
```

`<copa-share>` renders into a **Shadow DOM**: your page's CSS cannot restyle
the widget and the widget's CSS cannot leak out. Attributes: `config-url`,
`endpoint` (id to show first), `theme` (`light`, `dark`, `auto`). Properties:
`config` (object or JSON string), `tokenSources`.

`Copa.mount(element, options)` accepts `configUrl`, `config`, `endpointId`,
`theme`, `tokenSources`, `onItem`, `onAuthChange`, `onError` and returns
`{ element, ready, unmount() }`.

### ES module / Preact component

```tsx
import { CopaShare, defineCopaShare } from 'copa-widget';   // preact is a peer dependency

<CopaShare
  configUrl="/copa-widget.json"          // or config={{ version: 1, … }}
  onReady={(copa) => (window.copa = copa)}
  onItem={(item) => console.log('new item', item)}
  onAuthChange={(state, endpointId) => {}}
  onError={(err) => console.warn(err)}
/>

defineCopaShare();   // optional: registers <copa-share> (the script-tag bundle does it for you)
```

The component renders in your DOM without style isolation; it only uses classes
under `.copa-share`, and everything it draws is themable by the custom
properties below. React apps can alias `react` and `react-dom` to
`preact/compat`.

### What the user gets

- **Text**: push to / pull from the namespace clipboard (within the namespace's
  `size_limit`). Controls the credential cannot use (read-only / write-only
  tokens) are not shown.
- **Files and images**: drop, choose or paste (images from the system
  clipboard); only shown when the server reports file support. Bytes go straight
  to the object store through presigned URLs — the browser never holds storage
  credentials. Text above `size_limit` is sent as a `clipboard.txt` file.
- **History**: newest first with preview, size and time left; items added or
  removed on other devices show up live (`/ws/events`), with a manual
  **Refresh** when live updates are not available. Previews are text or an
  image from a fresh presigned URL — received HTML is shown as source and never
  executed; only `http(s)` URLs become links.

## Configuration file

`copa-widget.json` (any name works). Its JSON Schema is
[`web-widget/schema/copa-widget.schema.json`](../web-widget/schema/copa-widget.schema.json);
add `"$schema"` to get editor completion.

```json copa-widget.json
{
  "version": 1,
  "defaultEndpoint": "work",
  "endpoints": [
    {
      "id": "work",
      "url": "https://copa.example.com",
      "namespace": "team",
      "auth": {
        "method": "oauth2",
        "tokenService": "https://auth.example.com",
        "audience": "https://copa.example.com",
        "persist": "memory"
      }
    },
    {
      "id": "lan",
      "url": "http://127.0.0.1:8080",
      "auth": { "method": "pairing", "protocol": "spake2" }
    }
  ],
  "ui": { "theme": "auto" }
}
```

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | Format version. Currently `1`. A document with a newer version is rejected with an "upgrade the widget" error and no request is made. |
| `endpoints` | yes | One or more endpoints (below). |
| `defaultEndpoint` | no | `id` of the endpoint selected first. The user can switch between endpoints; the choice is remembered per browser. |
| `ui.theme` | no | `light`, `dark` or `auto`. |

Unknown optional keys are ignored with a console warning.

## Endpoints

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique name of the endpoint. |
| `url` | yes | Base URL of the copa server. Must be `https`; `http` is accepted only for loopback addresses (`localhost`, `127.x.x.x`, `[::1]`). |
| `namespace` | no | Clipboard namespace, default `default`. |
| `auth` | yes | Exactly one authentication object (below). |

An endpoint with a problem is refused on its own (the widget reports which
field is invalid); the other endpoints stay usable.

## Authentication methods

`auth.method` is one of `static-token`, `oauth2`, `pairing`.

### `static-token`

A fixed bearer token.

```json
{ "method": "static-token", "tokenFrom": "host" }
```

| Key | Meaning |
|---|---|
| `token` | The token itself, **inline in the file**. |
| `tokenFrom` | Name of a token provider registered by the host application; the widget asks it for the token when needed and never stores it. |

Exactly one of `token` and `tokenFrom` is required.

### `oauth2`

"Sign in with …" in a popup window against a **central token service** that
is independent of copa (it may serve many applications). The service performs
the OAuth2/OIDC exchange with the identity provider and issues a short-lived
signed access token plus a refresh token; the widget uses the access token to
talk to the copa server, which only verifies it.

```json
{
  "method": "oauth2",
  "tokenService": "https://auth.example.com",
  "audience": "https://copa.example.com",
  "popup": { "width": 480, "height": 640 },
  "persist": "session"
}
```

| Key | Meaning |
|---|---|
| `tokenService` | Base URL of the token service. Its endpoints are read from `<base>/.well-known/copa-token-service`. |
| `loginUrl`, `tokenUrl`, `refreshUrl`, `logoutUrl`, `pollUrl` | Explicit endpoint URLs instead of `tokenService`. `loginUrl`, `tokenUrl`, `refreshUrl` and `logoutUrl` are all required then; `pollUrl` is optional. |
| `audience` | The audience the token must be issued for. Default: the origin of the endpoint `url`. |
| `popup` | `width` / `height` of the login window (200–4000). |
| `persist` | `memory` (default), `session` or `local`: where the refresh token is kept across reloads. |
| `flow` | `popup` (default) or `redirect`: sign in on this page instead of in a pop-up window (see below). |

Either `tokenService` or all four explicit URLs are required, all must be
`https` (or loopback). `clientId` and `clientSecret` are **rejected**: identity
provider settings belong to the token service, never to the page.

**Sign-in flows.** By default the widget opens a **pop-up window** from the click
(so blockers allow it), the user signs in there, and the window hands a
single-use *login code* back with `postMessage` — to the page's origin only, and
only accepted from the token service's origin. The widget redeems the code with
a secret (`verifier`) it never sent anywhere, and receives the tokens. Tokens
never travel in a URL or a message. If the identity provider's page cuts the link
to the opener (`Cross-Origin-Opener-Policy`), the widget finds the result by
polling instead; the token service's page tells it that this happened, so a
window that merely *looks* closed is not mistaken for a cancellation.

If pop-ups are blocked the widget says so and offers **Sign in on this page**:
the whole page navigates to the token service and back
(`flow: "redirect"` makes this the default). The login code comes back in the
URL **fragment** (never sent to a server), bound to a `state` stored in
`sessionStorage`; the widget redeems it with the stored verifier and removes the
code from the address bar immediately.

While a sign-in is running the widget shows *Waiting for sign-in…* with a
**Cancel** button; a cancellation is reported quietly (it is not an error).
The access token lives in memory; with `persist` set, only the **refresh token**
is stored, and tabs sharing it renew in turn (Web Locks) so the service's
reuse detection does not sign everyone out.

### The token-service contract

Any service that implements this can be used (`token-issuer/` in this
repository is a complete reference for tests). All URLs come from
`<base>/.well-known/copa-token-service`:

```json
{ "issuer": "https://auth.example.com", "jwks_uri": ".../jwks.json", "login_url": ".../login",
  "poll_url": ".../poll", "token_url": ".../token", "refresh_url": ".../refresh", "logout_url": ".../logout" }
```

| Call | Meaning |
|---|---|
| `GET login_url?audience=A&origin=O&challenge=C` | the sign-in page. `A` = the copa server, `O` = the page's origin (must be allowed for this application), `C` = base64url(SHA-256(verifier)). It reports back with `opener.postMessage({type:"copa-login", login_code}, O)`. Redirect mode adds `mode=redirect&redirect_uri=…&state=…` and returns the user to `redirect_uri#copa_login_code=…&state=…` |
| `POST poll_url {verifier}` | `{status: pending\|ok\|denied, detached, login_code?}` — the fallback when the opener link is gone |
| `POST token_url {login_code, verifier}` | single-use code (≈60 s) → `{access_token, access_expires_at, refresh_token, refresh_expires_at}` (times in unix ms) |
| `POST refresh_url {refresh_token}` | rotates the refresh token; a reused one must end the session |
| `POST logout_url {refresh_token}` | ends the session |

The service must check `O` (and `redirect_uri`) against an allow-list of
applications, issue tokens whose `aud` is `A`, keep access tokens short-lived
(5–15 minutes) and send CORS headers for the allowed origins on the JSON
endpoints.

### `pairing`

Dynamic pairing with an operator: the user enters a short code (`spake2`) or
confirms a matching fingerprint (`ecdh`) and receives a time-limited device
credential.

```json
{ "method": "pairing", "protocol": "spake2", "ttlHint": 86400 }
```

| Key | Meaning |
|---|---|
| `protocol` | `spake2` or `ecdh` (required). |
| `ttlHint` | Wished credential lifetime in seconds; the server decides. |

## Validation and loading

The widget validates the document before any network request to an endpoint.
It can be supplied as a URL (`configUrl`), an object or JSON string, or an
inline `<script type="application/json" id="copa-config">` element. When it
cannot be used the widget shows an error naming the cause — network failure,
HTTP status, JSON syntax error or schema violation (with the offending field
paths) — and reports it to the host through `onError`.

## Secrets

- An inline `token` is visible to **anyone who can load the page**. Use it
  only for local or throw-away setups; prefer `tokenFrom`, `oauth2` or `pairing`.
- The widget sends credentials only in the `Authorization` header, never in a
  URL, and never writes them to logs.
- Time-limited credentials are kept in memory unless `persist` asks for
  `session` or `local` storage.

## Host API

The handle (from `onReady`, `Copa.mount(...).ready`, or the `<copa-share>`
element's methods) lets the host application drive the widget:

| Call | Meaning |
|---|---|
| `share(data, opts?)` | `data` is a string, `File` or `Blob`. Text within the limit goes to the clipboard endpoint, everything else is uploaded as a file item (a `Blob` without name or type gets `clipboard.<ext>` and a type sniffed from its bytes). Resolves with the stored item. |
| `paste()` | The namespace's current clipboard text. |
| `signIn()` / `signOut()` | Interactive sign-in (`oauth2`, `pairing`). |

Calls made while signed out are **rejected with `CopaAuthError`** (code
`not-authenticated`) — they are not queued — and the widget shows its sign-in
prompt. Other refusals are `ShareError` with a `code`: `too-large`, `forbidden`
(read-only credential), `unsupported` (files not enabled), `empty`.

Events: `onItem(item)` once for every stored item (your own shares and items
from other devices), `onAuthChange(state, endpointId)` with `signed-out`,
`pending`, `ready` or `expired`, `onError(error)`. The element emits them as
composed `copa:item`, `copa:auth` and `copa:error` DOM events (`event.detail`).

`tokenFrom` endpoints ask a host-provided function for the token each time it
is needed:

```js
Copa.mount(el, { config, tokenSources: { host: async () => await myApp.getCopaToken() } });
```

## Theming

Set these CSS custom properties on `<copa-share>` or any ancestor (they cross
the shadow boundary); anything you do not set keeps the built-in light or dark
default:

| Property | Default (light) | Meaning |
|---|---|---|
| `--copa-accent` | `#2563eb` | primary buttons, focus ring, links |
| `--copa-bg` / `--copa-fg` | `#ffffff` / `#1f2328` | background / text |
| `--copa-muted` | `#656d76` | secondary text |
| `--copa-border` | `#d0d7de` | borders |
| `--copa-error` / `--copa-ok` | `#cf222e` / `#1a7f37` | status colours |
| `--copa-radius` | `8px` | corner radius |
| `--copa-font` | system UI font | font family |

`theme` is `light`, `dark`, or `auto` (follows the operating system; the
default).

## Cross-origin setup (CORS)

The widget runs on **your** page, so two things must allow your page's origin:

1. **copasrv API.** By default any origin may call the API. In production
   restrict it in `config.toml`:

   ```toml
   [server]
   allowed_origins = ["https://app.example.com"]
   ```

2. **The object-store bucket**, for file uploads. The browser `PUT`s straight to
   the bucket, so the bucket's CORS policy must list the host page's origin and
   allow `PUT` with the headers `content-type` and `content-disposition`. With
   the bundled Garage setup add the origin to `COPA_CORS_ORIGINS` in
   `deploy/garage/.env` and re-run `deploy/garage/init.sh`. See
   [FILES.md](FILES.md#troubleshooting): an upload that fails immediately with
   "blocked before reaching the object store" is almost always this.

`https` pages need `https` endpoints and an `https` `public_url` for the
object store (mixed content is blocked).

## Try it

`web-widget/demo/index.html` is a host page that follows the script-tag steps
above. With a running `copasrv` (here on port 8080):

```bash
cd web-widget && yarn build
python3 -m http.server 5180            # serves this folder
# open http://localhost:5180/demo/?url=http://127.0.0.1:8080&token=<token>
```

## Server: tokens and event tickets

copasrv recognises several kinds of credential in `Authorization: Bearer …`.
They are tried in this order and all end up as the same thing: read and/or
write access to one namespace.

1. **Static tokens** of the namespace (`read_token`, `write_token`,
   `rw_token`) — unchanged, constant-time comparison.
2. **Device tokens** (`v1.<payload>.<mac>`), issued by copasrv after a
   successful pairing. Enable them with `[server.pairing] enabled = true`
   (see `config.toml.example`). A device token is bound to one namespace, grants
   `r`, `w` or `rw`, has an expiry and can be revoked per device; it is
   verified with an HMAC (the MAC is checked before the payload is parsed).
   The signing secret is generated into `<state_dir>/auth.json` (mode `0600`,
   default `~/.local/state/copa`) together with the revocation list; set
   `COPA_TOKEN_SECRET` (at least 16 characters) to provide the secret from the
   environment instead — it is then never written to disk. Rotating the secret
   invalidates every device token.
3. Tokens from **trusted issuers** (JWT) — see [Trusting a token service](#trusting-a-token-service).

Without `[server.pairing]` there is no state file and nothing but static
tokens (and trusted issuers, if configured) is accepted.

### Event tickets

Browsers cannot set headers on a WebSocket upgrade, so the live event stream
(`/ws/events`) historically took the token in the URL (`?token=`). Putting a
time-limited credential in a URL is worse than a static one, so there is a
better way:

```
POST /api/events/ticket          (Authorization: Bearer …, X-Copa-Namespace: team)
→ { "ticket": "…", "expires_at": 1790000030000 }

GET  /ws/events?namespace=team&ticket=…
```

- A ticket is **single use** and valid for **30 seconds**; it is bound to the
  namespace it was issued for and a namespace-mismatch spends it.
- Only credentials with **read** access get one.
- It is not a bearer token: it works nowhere except on `/ws/events`.
- The stream **ends when the credential that obtained the ticket expires**; the
  widget then reconnects with a fresh ticket.
- `?token=` on `/ws` and `/ws/events` keeps working for static tokens (and
  device tokens, which close at expiry too); the widget prefers a ticket and
  falls back to `?token=` only for static tokens on servers without tickets.

## Trusting a token service

A **token service** is a separate application that signs users in (OAuth2/OIDC,
passwords, SSO …) and hands the widget short-lived signed access tokens. It may
serve many applications; copa is just one of them. copasrv does not take part
in the login: it only **verifies** the tokens, so it never holds an OAuth client
secret and never sees a refresh token.

Tell copasrv which issuers to trust in `config.toml` (the commented example in
`config.toml.example` is tested to be valid):

```toml
[server.auth.issuers.hub]
iss         = "https://auth.example.com"            # must equal the token's `iss`
jwks_url    = "https://auth.example.com/jwks.json"  # where its signing keys are published
audience    = "https://copa.example.com"            # this server's id; must be in the token's `aud`
algorithms  = ["ES256", "RS256"]                    # default
leeway_secs = 30                                    # clock skew for exp/nbf (max 300)

[[server.auth.issuers.hub.map]]
claim = "scope"
value = "copa:shared:rw"
namespace = "shared"
access = "rw"

[[server.auth.issuers.hub.map]]
claim = "groups"
value = "copa-readers"
namespace = "shared"
access = "r"
```

### What is checked on every request

A bearer that looks like a JWT (three dot-separated parts) is accepted only if:

1. its `iss` equals a configured issuer (the claim is used **only to pick the
   entry**; nothing in the token is trusted before its signature verified);
2. its `alg` is in that issuer's allow-list — **symmetric algorithms (`HS*`) and
   `none` are refused**, also at startup if configured;
3. the signature verifies against the key with the token's `kid` from the
   issuer's JWKS (`jku`, `x5u` and keys embedded in the token are ignored);
4. `aud` contains the configured `audience` and `exp` is in the future and
   `nbf` not in the future (± `leeway_secs`), using the server's own clock.

Static tokens and device tokens keep working next to issuers.

### Claims → access

Each `[[…map]]` rule says: *if this claim matches `value`, grant `access`
(`r`, `w`, `rw`) in `namespace`*. All matching rules of one token are unioned.

- `claim` may be a dotted path (`realm_access.roles`); a claim name that itself
  contains dots (`https://example.com/roles`) is tried first as written.
- A string claim is matched as a whole, **except `scope` and `scp`, which are
  matched per space-separated scope**. An array claim matches if any element
  does. `*` matches any text (`*@example.com`).
- A **valid** token that no rule maps in the requested namespace gets **403**;
  an invalid one gets **401**. Clipboard, history, files, capabilities and the
  event-ticket endpoint all use the same rule.
- The stream opened with a ticket obtained by a JWT ends when the token expires.

### Keys

- Keys are fetched on first use and refreshed after `jwks_ttl_secs` (600).
- A token with an **unknown `kid`** triggers a refresh, but at most one per
  `jwks_min_refresh_secs` (10), so bogus key ids cannot make copasrv hammer the
  issuer. After a key rotation, tokens signed by the new key therefore start
  working within that interval.
- If the issuer is unreachable, the **previously fetched keys keep working**.
- `jwks_url` must be `https` (`http` only for loopback, for tests).

### Revocation

copasrv has no way to revoke an access token that was already issued: it is
valid until it expires. Use **short lifetimes (5–15 minutes)** and revoke the
refresh token at the token service.

### Logs

A rejected token is logged with the reason (`token expired`, `signature does
not verify`, `no mapping for namespace 'x'`, …) and **never** the token, its
parts, the `Authorization` header or a query string (tested against the real
binary).

### Trying it with the test token issuer

`token-issuer/` in this repository is an independent token service for testing
(fake users, JWKS, rotating keys, fault injection). With `copasrv` built:

```bash
cd token-issuer
uv run python dev/copasrv_e2e.py
```

starts both, signs users in through the real endpoints and checks what copasrv
makes of the tokens — including expired, wrong-audience, unknown-key,
`alg: none` and HS256-confusion tokens, key rotation and a failing JWKS.

## Size

The embeddable ES module is small and stays small for hosts that do not use
sign-in: the OAuth2 code is a **separate chunk** loaded only when an `oauth2`
endpoint is configured. `yarn size` (after `yarn build`) enforces budgets —
entry ≈ 15 kB gzipped, OAuth2 chunk ≈ 4 kB, the self-contained script-tag bundle
≈ 22 kB including Preact — and fails if sign-in code leaks into the entry chunk.

## Pairing devices

Pairing lets a browser that has no token get one, with an operator in the loop —
no shared secret to copy around. It is off unless configured:

```toml
[server.pairing]
enabled         = true
state_dir       = "/var/lib/copa"   # auth.json: signing secret, devices, revocations (0600)
device_ttl_secs = 86400             # lifetime of a device token (default 24 h)
sliding_renewal = false             # true: a valid device token can buy a fresh one (POST /api/pair/renew)
window_ttl_secs = 120               # how long a pairing window stays open
max_attempts    = 5                 # failed codes after which a window closes
rate_limit      = 30                # requests per source address per 10 s on the pairing endpoints
```

### Operator flow

```bash
copacli pair open --access r --name "kitchen tablet"     # prints a code such as  K7QF2M-48217730
```

1. **Open a window** for a namespace and an access level (`r`, `w`, `rw`). Needs
   a token with write access to that namespace. At most 16 windows are open at
   once; each lasts `window_ttl_secs`.
2. **Short code (SPAKE2)** — give the code to the user. They type it into the
   widget (`"auth": {"method": "pairing", "protocol": "spake2"}`). The code is
   the password of a SPAKE2 exchange: it never travels over the network, a
   passive observer learns nothing, and a guess is an *online* attempt that can
   be tried only `max_attempts` times per window. Both sides then prove they
   derived the same key before anything is issued, and the credential is
   delivered encrypted under that key.
3. **Key exchange (ECDH)** — with `"protocol": "ecdh"` the widget shows a
   16-digit **fingerprint** of the exchange. List what is waiting and approve the one
   whose digits equal the device's screen:

   ```bash
   copacli pair pending
   copacli pair approve 1234 5678 9012 3456       # by fingerprint (or by id)
   copacli pair reject  1234 5678 9012 3456
   ```

   If someone sits between the device and the server, the two fingerprints differ:
   **reject on any mismatch.** `approve --client-pub <key>` takes the public key
   scanned from the device's QR code and refuses to approve a pairing with a
   different key.
4. **Manage devices:** `copacli pair devices`, `copacli pair revoke <device>`.
   Revocation is per device and takes effect immediately; other devices are
   unaffected, and records survive a restart (open windows do not).

### Properties

- A device token is bound to one namespace and one access level and **expires**
  (`device_ttl_secs`); with `sliding_renewal` it can be renewed while it is still
  valid, otherwise the device pairs again.
- All failures — wrong code, unknown or expired window, spent window, unknown or
  expired session — are answered identically (`403 pairing failed`), and an
  unknown window id gets a normal-looking decoy exchange, so the endpoints do
  not reveal which windows or codes exist.
- The pairing endpoints are **rate-limited per source address** (30 requests per
  10 s → `429` with `Retry-After`). Behind a reverse proxy every client appears
  as the proxy's address, so the limit is then shared: raise `rate_limit` and
  limit per client at the proxy instead.
- The server log records events (`window opened`, `confirmation failed`,
  `device … enrolled`, `ecdh pairing approved`) and **never** a code, key,
  session id or token.
- Pairing endpoints are `404` when pairing is not enabled.

### Protocol summary (for implementers)

| Step | Request | Notes |
|---|---|---|
| open | `POST /api/pair/windows` `{access, name}` | operator; → `{window_id, code, display_code, expires_at}` |
| SPAKE2 | `POST /api/pair/spake2/start` `{window_id, msg}` → `{session_id, msg}` | SPAKE2 over Ed25519 (`spake2` crate; identities `copa-widget` / `copa-server`), password = the 8-digit code; messages are 33 bytes (side byte + point) in base64url |
| | `POST /api/pair/spake2/confirm` `{session_id, mac, name?}` → `{mac, sealed}` | `mac` = HMAC-SHA256(client key, `"client"` ‖ transcript); the server checks it **before** issuing; `sealed` = AES-256-GCM(`nonce‖ct`, transcript as AAD) of `{token, expires_at, namespace, access, device}` |
| ECDH | `POST /api/pair/ecdh/start` `{window_id, pub}` → `{session_id, pub, fingerprint}` | P-256, uncompressed points; shared secret = the x-coordinate |
| | `POST /api/pair/ecdh/result` `{session_id, mac, name?}` | polled: `pending` / `denied` / `approved` + `{mac, sealed}`; delivered once, only to the holder of the key |
| operator | `GET /api/pair/pending`, `POST /api/pair/pending/:id/(approve\|reject)`, `GET /api/pair/devices`, `DELETE /api/pair/devices/:id` | write access to the namespace |

Key schedule (both protocols): HKDF-SHA256 over the shared secret with the info
strings `copa-pair/v1/client-mac`, `…/server-mac`, `…/encrypt`; the transcript is
SHA-256 over the length-prefixed protocol name, window id and both public
messages; the fingerprint is the first 8 bytes of the transcript as a big-endian
integer modulo 10^16, in four groups of four digits.
