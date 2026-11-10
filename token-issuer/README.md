# token-issuer

An **independent token service** for testing the copa widget and copasrv's
trusted-issuer authentication. It is *not* part of copa and shares no code with
it: it implements the widget ↔ token-service contract the way any third-party
service would, so the widget and the server are tested against something real.

- Popup login (fake-user picker, or a real OIDC provider upstream)
- Publishes `/.well-known/copa-token-service` and a JWKS (ES256)
- Issues short-lived **JWT access tokens** with configurable claims, plus rotating **refresh tokens**
- Fault injection: expired / wrong-audience / unknown-key / `alg: none` / HS256-confusion tokens, COOP popup pages, failing or slow JWKS

> Test and demo tool. Its endpoints are public by design (like an IdP), the fake
> users have trivial passwords, and state is in memory. Keep it on loopback.

## Quickstart

```bash
make token-issuer                  # from the copa repo root; same as:
cd token-issuer && uv run token-issuer --ephemeral --port 8090 --admin-token dev-admin
```

```bash
curl -s http://127.0.0.1:8090/.well-known/copa-token-service
curl -s http://127.0.0.1:8090/jwks.json
```

Open the popup yourself (any browser; `origin` must be an allowed origin — loopback is allowed by default):

```
http://127.0.0.1:8090/login?audience=https://copa.example.com&origin=http://localhost:5180&challenge=<S256 challenge>
```

Or script a whole login (this is what the widget does, minus the popup):

```bash
ISSUER=http://127.0.0.1:8090
VERIFIER=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 1. start a login, 2. "click" Sign in as alice, 3. read the login code out of the popup page
LOGIN_ID=$(curl -s "$ISSUER/login?audience=https://copa.example.com&origin=http://localhost:5180&challenge=$CHALLENGE" \
  | sed -n 's/.*name="login_id" value="\([^"]*\)".*/\1/p')
CODE=$(curl -s -d "login_id=$LOGIN_ID&user=alice&password=alice&action=signin" "$ISSUER/login/submit" \
  | sed -n 's/.*"login_code": "\([^"]*\)".*/\1/p')

# 4. redeem it with the verifier
curl -s -H 'Content-Type: application/json' -d "{\"login_code\":\"$CODE\",\"verifier\":\"$VERIFIER\"}" "$ISSUER/token"
```

## The contract

All URLs come from the discovery document (`GET /.well-known/copa-token-service`):

```json
{ "issuer": "http://127.0.0.1:8090", "jwks_uri": ".../jwks.json", "login_url": ".../login",
  "poll_url": ".../poll", "token_url": ".../token", "refresh_url": ".../refresh", "logout_url": ".../logout" }
```

| Endpoint | Request | Result |
|---|---|---|
| `GET login_url?audience=A&origin=O&challenge=C` | `A` = the copa server the token is for; `O` = origin of the page that opens the popup; `C` = `base64url(sha256(verifier))` the widget keeps the verifier secret | The sign-in page. On success the page does `opener.postMessage({type:"copa-login", login_id, login_code}, O)` and closes; on cancel `{type:"copa-login-error", login_id, error}` |
| `POST poll_url` `{verifier}` | for when the provider cut `window.opener` (COOP): the verifier is the widget's secret, so it needs no login id | `{status, detached, login_code?}` with status `pending`, `ok` or `denied`. `detached: true` means the popup reported (via `POST /login/detached`, sent by the login page itself) that it has no `window.opener`, so the widget must not treat `popup.closed` as a cancellation |
| `GET login_url?mode=redirect&redirect_uri=R&state=S&audience=A&challenge=C` | full-page variant for popup-hostile environments: after signing in the user is sent back (303) to `R#copa_login_code=…&state=S` (or `R#copa_login_error=cancelled&state=S`). `R`'s origin must be allowed; it replaces `origin`; `S` is 8–128 chars of `[A-Za-z0-9_-]` | the same login page |
| `POST token_url` `{login_code, verifier}` | the code is single use (60 s) and bound to the verifier | token pair (below) |
| `POST refresh_url` `{refresh_token}` | rotates: the old token is consumed | new token pair |
| `POST logout_url` `{refresh_token}` | idempotent | `{ok:true}`; the refresh token stops working |

Token pair (times are unix **milliseconds**):

```json
{ "token_type": "Bearer", "access_token": "<JWT>", "expires_in": 600, "access_expires_at": 1790000600000,
  "refresh_token": "<opaque>", "refresh_expires_at": 1790086400000, "scope": "copa:team:rw", "sub": "alice" }
```

Errors are OAuth-style: `400 {"error":"invalid_grant","error_description":"…"}`. Presenting an
already-rotated refresh token revokes the whole session (assumed theft).

**Access token** (JWT, `alg: ES256`, header `typ: at+jwt`, `kid` = RFC 7638 thumbprint):

| Claim | Meaning |
|---|---|
| `iss` | the service's public URL |
| `aud` | the audience requested at login |
| `sub`, `email`, `name` | the user |
| `groups` | list of group names |
| `scope` | space-separated, e.g. `copa:team:rw copa:other:r` |
| `iat`, `nbf`, `exp`, `jti` | timing and id (default lifetime 600 s; use 300–900 s) |

**Origin policy**: `origin` at login and `Origin` on the JSON endpoints must be allowed
(`--allowed-origin`, repeatable; default: loopback only). Foreign origins get 403 and
no CORS headers. Discovery and JWKS are readable from any origin.

## Fake users

Default users (`alice`/`alice` → `copa:team:rw`, `bob`/`bob` → `copa:team:r`, `carol`/`carol` → no
scope) come from [`users.example.json`](users.example.json). Use your own with `--users-file`:

```json
{ "users": [ { "id": "dana", "name": "Dana", "email": "dana@example.com", "password": "pw",
               "groups": ["copa-team"], "scope": "copa:team:rw", "claims": { "tenant": "t1" } } ] }
```

Omit `password` for a pick-a-user login. `claims` are copied into the token (they cannot override registered claims).

## Options

Layered configuration: CLI > environment (`TOKEN_ISSUER_*`) > `~/.config/token-issuer/config.toml` (`[token-issuer]`) > defaults. `token-issuer --help` lists everything.

| Option | Default | |
|---|---|---|
| `--host`, `--port` | `127.0.0.1`, `8090` | `--port 0` picks a free port |
| `--public-url` | `http://<host>:<port>` | the `iss` and the base of every URL |
| `--ephemeral` / `--state-dir` | keys in `~/.local/state/token-issuer` | `--ephemeral`: new keys every start |
| `--users-file` | built-in users | |
| `--access-ttl`, `--refresh-ttl` | 600 s, 86400 s | |
| `--allowed-origin`, `--allowed-audience` | loopback / any | repeatable |
| `--admin-token` | off | enables `/admin/*` (below) |
| `--fault NAME[:PARAM]` | none | repeatable, see below |
| `--upstream-*` | off | upstream OIDC mode (below) |

## Fault switches

Start with `--fault name` / `TOKEN_ISSUER_FAULTS=a,b`, or change them while running with the admin API.
Each produces tokens a correct resource server **must reject** (or a behaviour it must survive):

| Fault | Effect |
|---|---|
| `expired-token` | `exp` one minute in the past |
| `wrong-audience` | `aud` = `https://wrong.example` |
| `wrong-issuer` | `iss` = `https://evil.example` |
| `unknown-kid` | signed by a key that is not in the JWKS, with an unknown `kid` |
| `bad-signature` | valid token with a tampered signature |
| `alg-none` | unsigned token, `alg: none` |
| `hs256-confusion` | `alg: HS256`, signed with the **public key** as the HMAC secret |
| `short-ttl[:N]` | access tokens live N seconds (default 5) |
| `coop` | popup pages send `Cross-Origin-Opener-Policy: same-origin` (severs `window.opener`; forces the poll path) |
| `jwks-fail` | `GET /jwks.json` → 500 |
| `jwks-slow[:N]` | `GET /jwks.json` delayed N seconds (default 3) |

## Admin API (only with `--admin-token`)

`Authorization: Bearer <admin token>` on:

| Call | |
|---|---|
| `POST /admin/rotate-key` | new signing key; the old one stays in the JWKS (overlap). Returns `{kid}` |
| `POST /admin/retire-key` `{kid}` | remove a key from the JWKS (not the active one) |
| `GET /admin/faults`, `POST /admin/faults` `{"faults":["short-ttl:3"]}` | read / replace the active faults |

## Upstream mode (real OIDC provider)

Instead of the fake-user form, users sign in at an OIDC provider; the issuer is the confidential
client, maps the user's claims to copa scopes and signs its own token (provider tokens never leave the process):

```bash
TOKEN_ISSUER_UPSTREAM_CLIENT_SECRET=… uv run token-issuer \
  --upstream-issuer https://idp.example.com --upstream-client-id token-issuer \
  --upstream-map-file map.json
```

Register `<public-url>/login/callback` as the redirect URI at the provider. `map.json`:

```json
{ "rules": [ { "claim": "groups", "value": "copa-team", "scope": "copa:team:rw" },
             { "claim": "email", "value": "*@example.com", "scope": "copa:public:r" } ] }
```

Matching rules are unioned; values may use `*` patterns. The fake-user form is disabled in this mode.

**Try it with dex** (needs Docker; pulls `ghcr.io/dexidp/dex`):

```bash
./dev/run-dex-demo.sh
```

starts dex, starts the issuer in upstream mode, performs a complete popup login against dex as
`admin@example.com` and checks the signed token and its mapped scope.

## Use with copasrv and the widget

copasrv trusts the issuer through `[server.auth.issuers.<name>]` (`iss` = this service's public URL,
`jwks_url` = its `jwks_uri`, `audience` = the copa server's URL); the widget points at it with
`"tokenService": "http://127.0.0.1:8090"`. See `docs/WIDGET.md`.

## Tests

```bash
make test-token-issuer      # or: cd token-issuer && uv run pytest
```
