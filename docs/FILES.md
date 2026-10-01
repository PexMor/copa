# File sharing and clipboard history

copa can share files as well as text, and keeps a short history of what was
pushed. This page covers how to enable it, every option, how the flow works,
and how to run it safely on the internet.

- [How it works](#how-it-works)
- [Enable file sharing](#enable-file-sharing)
- [Options](#options)
- [History and expiry](#history-and-expiry)
- [Things to know before relying on it](#things-to-know-before-relying-on-it)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

## How it works

`copasrv` never handles file bytes. It checks the namespace token and hands out
a short-lived **presigned URL**; the client then talks to the S3-compatible
object store directly.

```
 client (copacli / web)            copasrv                    object store (S3 / Garage)
        │                             │                                  │
        │ POST /api/files             │                                  │
        │  {name, size}  ───────────▶ │ checks token, size, quota        │
        │ ◀─── {id, upload_url,       │ signs a PUT for exactly this     │
        │       headers}              │ key, size and headers            │
        │                             │                                  │
        │ PUT upload_url (file bytes) ─────────────────────────────────▶ │
        │                             │                                  │
        │ POST /api/files/{id}/complete                                  │
        │  ─────────────────────────▶ │ HEAD object, compare size ─────▶ │
        │ ◀─── item metadata          │ item becomes visible in history  │
        │                             │                                  │
        │ GET /api/files/{id} ──────▶ │ checks token, signs a GET        │
        │ ◀─── {download_url}         │                                  │
        │ GET download_url ────────────────────────────────────────────▶ │
        │                             │                                  │
        │                             │ on expiry / delete / eviction:   │
        │                             │ DELETE object ─────────────────▶ │
```

What a presigned URL allows: one HTTP verb on one object, for a few minutes.
An upload URL additionally fixes the exact body length and the stored headers,
so it cannot be used to store something bigger or something a browser would
render. The S3 credentials stay on the server.

## Enable file sharing

1. **Run an object store.** For testing or a small deployment use the bundled
   Garage setup:

   ```bash
   make s3-up        # starts Garage in Docker, creates bucket + key, sets CORS
   ```

   It prints a `[server.storage]` block (also saved to
   `deploy/garage/storage.toml`). See [deploy/garage/README.md](../deploy/garage/README.md).

2. **Add the block to `~/.config/copa/config.toml`** and restart `copasrv`:

   ```toml
   [server.storage]
   public_url        = "http://127.0.0.1:3900"
   region            = "garage"
   bucket            = "copa"
   access_key_id     = "GK…"
   secret_access_key = "…"
   ```

   The server logs `files: enabled (key prefix 'copa/')`.

3. **Use it.**

   ```bash
   copacli put -r local report.pdf     # prints the item id
   copacli get -r local                # newest file → ./report.pdf
   copacli history -r local
   ```

   In the web app, drop a file on the clipboard panel, paste one, or use
   **Upload file**.

File sharing is off unless `[server.storage]` is present. History and expiry of
text items work either way.

## Options

### `[server.storage]`

| Key | Default | Meaning |
|-----|---------|---------|
| `public_url` | — (required) | Base URL **clients** use to reach the object store. Presigned URLs are signed for this host, so it must be exactly what clients connect to (scheme, host and port). |
| `endpoint` | `public_url` | Base URL `copasrv` itself uses for its HEAD / DELETE / LIST calls. Set it to the local address when `public_url` goes through a reverse proxy. |
| `bucket` | — (required) | Bucket name. Path-style addressing is always used (`https://host/bucket/key`), so one hostname is enough. |
| `access_key_id` | — (required) | Access key. Give it read/write on this bucket only. |
| `secret_access_key` | — (required) | Secret key. The `COPA_S3_SECRET_ACCESS_KEY` environment variable takes precedence and lets you keep it out of the file. |
| `region` | `garage` | Signing region. |
| `key_prefix` | `copa/` | Objects are stored under `<prefix><namespace>/<random id>`. Must not be empty. **One prefix belongs to exactly one copasrv.** |
| `presign_ttl_secs` | `300` | Lifetime of upload and download URLs (1 – 604800). |

`copasrv` refuses to start when the section is present but a required key is
missing, and warns when `public_url` is plain `http` on a non-loopback host.

### Per namespace (`[server.namespaces.<name>]`)

| Key | Default | Meaning |
|-----|---------|---------|
| `history_limit` | `20` | Items kept; adding one more evicts the oldest. |
| `item_ttl_secs` | `86400` (24 h) | Lifetime of every item, text and file. Must be greater than 0. |
| `files` | `true` when storage is configured | Set `false` to disable files for this namespace. |
| `max_file_size` | `52428800` (50 MiB) | Largest single file. |
| `file_quota_bytes` | `524288000` (500 MiB) | Total bytes of stored files plus uploads in progress. |
| `size_limit` | `16384` | Largest text item (unchanged). |

### `[server]`

| Key | Default | Meaning |
|-----|---------|---------|
| `allowed_origins` | any origin | List of origins allowed by CORS on the copasrv API, e.g. `["https://copa.example.com"]`. |

A client can read the effective values from `GET /api/capabilities`.

## History and expiry

- Every push creates an item; `GET /api/clipboard` and `/ws` keep returning the
  newest *text*, so existing clients are unaffected by file items.
- Pushing text identical to the newest text item refreshes that item instead of
  adding a duplicate.
- **Every item expires** after `item_ttl_secs`. A client may ask for less
  (`X-Copa-TTL: <secs>` header, `ttl_secs` in the upload request,
  `copacli put --ttl`); asking for more is clamped to the namespace value.
- An expired item is not served from the instant it expires. The server removes
  it — and deletes the object for a file — on its next cleanup pass, which runs
  every 30 seconds. Failed deletions are retried.
- An upload that is requested but not completed within the URL lifetime plus
  60 seconds is discarded, and whatever was uploaded is deleted.

## Things to know before relying on it

- **History is in memory.** Restarting `copasrv` empties it, exactly as the
  clipboard was always lost on restart.
- **On startup, and every 15 minutes, copasrv deletes every object under its
  `key_prefix` that it does not know about.** After a restart that is all of
  them. Never point two `copasrv` instances at the same bucket and prefix, and
  never put anything else under that prefix.
- **Single request uploads only** — no multipart, no resume. Keep
  `max_file_size` below what your reverse proxy accepts.
- **Files are not end-to-end encrypted.** Whoever operates the object store, or
  holds a read token for the namespace, can read them.
- `copa-tray`, the MQTT transport and the built-in fallback UI
  (`copasrv` without `--static-dir`) handle text only.

## Security checklist

Each item names the place where it is configured in the reference files.

| # | Do this | Where |
|---|---------|-------|
| 1 | **HTTPS for both hostnames** (copasrv and the object store). Tokens and presigned URLs are bearer secrets. | `deploy/garage/proxy/Caddyfile` (automatic certificates), `haproxy.cfg` (`bind :443 ssl`), `cloudflared.yml` (TLS at Cloudflare). `public_url = "https://…"` |
| 2 | **Keep copasrv and Garage on loopback**; only the proxy listens publicly. | copasrv: `bind = "127.0.0.1"` (the default). Garage: `ports: "127.0.0.1:…:3900"` in `docker-compose.yml`. |
| 3 | **Never expose Garage's RPC or admin ports.** | `docker-compose.yml` publishes port 3900 only; `garage.toml` has no `[admin]` and no `[s3_web]` section. |
| 4 | **Bucket-scoped credentials.** The key copasrv uses can read/write one bucket and nothing else. | `init.sh`: `garage bucket allow --read --write`, `garage key deny --create-bucket`. The owner-level key used for CORS setup is deleted at the end of the script. |
| 5 | **No anonymous access.** | Garage has none; verify with `curl -i http://127.0.0.1:3900/copa` → 403. |
| 6 | **Restrict CORS** on the bucket to the origin(s) serving the web app, and on copasrv with `allowed_origins`. | `COPA_CORS_ORIGINS` in `deploy/garage/.env`, then re-run `init.sh`; `allowed_origins` in `[server]`. |
| 7 | **Match body-size limits** to `max_file_size`. Cloudflare allows 100 MB per request on Free/Pro. | `request_body max_size` in `Caddyfile`; the `content-length` rule in `haproxy.cfg`; note in `cloudflared.yml`. |
| 8 | **Pass Host, path and query through unchanged** to the object store — they are what the signature covers. | Default in all three examples; `httpHostHeader` in `cloudflared.yml`. |
| 9 | **Keep secrets out of git and out of world-readable files.** | `deploy/garage/.gitignore` (`.env`, `storage.toml`, both created mode 600); `COPA_S3_SECRET_ACCESS_KEY`; `chmod 600 ~/.config/copa/config.toml`. |
| 10 | **Rotate tokens and keys.** | Namespace tokens: `copasrv --generate-token`, edit config, restart. S3 key: `docker compose exec garage /garage key delete --yes copa`, re-run `init.sh`, update `[server.storage]`. |
| 11 | **One key prefix per copasrv instance.** | `key_prefix` in `[server.storage]`. |
| 12 | **Lifecycle rule as a backstop**, so objects disappear even if copasrv is never started again. Must be longer than your largest `item_ttl_secs`. | `COPA_LIFECYCLE_DAYS` in `deploy/garage/.env` (default 8 days), applied by `init.sh`. |
| 13 | **Keep clocks in sync** (NTP) on the copasrv host and the object store; signatures are time-based. | Host configuration. |
| 14 | **Short TTLs.** Leave `presign_ttl_secs` at a few minutes and choose an `item_ttl_secs` no longer than you need. | `[server.storage]`, `[server.namespaces.*]`. |

Built-in protections that need no configuration: constant-time token
comparison; the new endpoints accept the token only in the `Authorization`
header (never in the URL); object keys are random and never contain the file
name; file names are sanitized; objects are stored as
`application/octet-stream` with `Content-Disposition: attachment`, so a browser
downloads rather than renders them; download URLs never outlive their item;
the server log contains item ids and sizes but no URLs, tokens or file names.

## Troubleshooting

**Browser upload fails immediately, "Upload was blocked before reaching the object store"**

The request never got an HTTP response, which almost always means the bucket's
CORS policy does not allow the page's origin. Add the origin shown in the
message to `COPA_CORS_ORIGINS` in `deploy/garage/.env` and re-run
`deploy/garage/init.sh`. The policy must allow `PUT` and the request headers
`content-type` and `content-disposition`. With Garage, use **one CORS rule per
origin** (as `init.sh` does): a rule listing several origins makes Garage answer
with all of them in `Access-Control-Allow-Origin`, which browsers reject.
`copacli` is not affected by CORS,
so `copacli put` working while the browser fails confirms this cause. Mixed
content (an `https` page with an `http` `public_url`) produces the same error.

**Object store returns 403 `SignatureDoesNotMatch` / upload rejected (403)**

- `public_url` is not exactly what the client connects to (different host or
  port), or a proxy rewrites the `Host` header, path or query string.
- The client sent a body of a different size, or different `Content-Type` /
  `Content-Disposition` headers, than the ones returned in `headers`.
- Clock skew between copasrv and the object store.

**`copacli put`: "the server does not support files"**

`[server.storage]` is missing, the namespace has `files = false`, or the server
is older than this feature.

**413 / "file is too large", 507 / "quota is exhausted"**

Raise `max_file_size` or `file_quota_bytes` for the namespace, remove items
(`copacli history rm <id>`, `copacli history clear`), or wait for expiry. A
`413` coming from the proxy rather than copasrv means the proxy's body limit is
below `max_file_size`.

**409 on `complete`**

The object was not uploaded, or its size differs from the declared size. The
pending upload has been discarded; start again.

**502 on `complete`**

copasrv could not reach the object store at `endpoint`. The upload stays
pending — retry `complete` once the store is reachable.

**Files vanish after restarting copasrv**

Expected: see [Things to know](#things-to-know-before-relying-on-it).
