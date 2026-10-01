# Design

## Context

See `proposal.md` for motivation. Current state relevant to the approach:

- `copasrv` (`src/main.rs`, one ~400-line file) holds per namespace a single `RwLock<Vec<u8>>` plus a `broadcast::Sender<Vec<u8>>`. `GET`/`POST /api/clipboard` and `/ws` read/write that buffer. Everything is in memory and is lost on restart; there are no tests.
- Auth is a bearer token compared with `==` against per-namespace `read_token` / `write_token` / `rw_token`; the token may also come from `?token=`. CORS is `Any`.
- `/ws` sends plain UTF-8 text frames whose whole payload is the clipboard content. `copacli watch`, `copa-tray` and the web app's `useWebSocket` all treat a frame as content, so nothing structured can be added to that stream.
- `copacli` uses blocking `ureq` for HTTP and `tokio-tungstenite` for WS. The web app is Vite + Preact + TS (`web/src`), served via `--static-dir` or from GitHub Pages (`docs/app/`), i.e. frequently from a different origin than `copasrv`. The embedded `web/ui.html` is the legacy fallback UI.
- `openspec/specs/` is empty, so every capability in this change is new.

Assumptions made (not confirmed with the user; cheap to revisit):

- "Dedicated backend API" = `copasrv` itself issues presigned URLs; no extra service.
- History stays in memory like today's buffer; surviving a restart is not required.
- All items expire, including the newest one (default 24 h).

## Goals / Non-Goals

**Goals:**

- File bytes go client ⇄ object store directly; `copasrv` handles only small JSON.
- A leaked presigned URL is worth little: one object, one verb, minutes of validity, fixed size.
- No object in the bucket outlives its history item, even after crashes or failed deletes.
- Old clients keep working against a new server; new clients degrade cleanly against an old server.
- Works with one public hostname for the object store behind Caddy / HAProxy / cloudflared.

**Non-Goals:**

- Multipart / resumable uploads (single `PUT` only; size cap keeps this reasonable).
- Persisting history to disk, multi-instance `copasrv` sharing one bucket prefix.
- End-to-end encryption of file contents; virus scanning; rate limiting.
- File support in `copa-tray`, the MQTT transport and the embedded `web/ui.html`.
- A `copasrv` container image (the compose file runs only the object store and, optionally, a proxy).

## Decisions

### 1. `copasrv` signs URLs locally with `rusty-s3`

Presigning SigV4 is pure computation, so `copasrv` signs without calling the store. `rusty-s3` is sans-IO, tiny, supports path-style URLs, custom signed headers, and `HeadObject` / `DeleteObject` / `ListObjectsV2` actions. The few server→store calls (HEAD on complete, DELETE, LIST for reconcile) are executed with the already-present `ureq` inside `spawn_blocking`.

- *Alternative: `aws-sdk-s3`* — heavy dependency tree and compile time for four operations.
- *Alternative: proxy bytes through `copasrv`* — simplest for clients and proxies, but puts large bodies in the server's path, contradicts the "small attack surface" stance in the README and the user's explicit presigned-URL request.

### 2. Two-phase upload: request → PUT → complete

`POST /api/files` creates a *pending* upload (id, key, declared size, deadline = presign TTL + 60 s) and returns a presigned `PUT`. `POST /api/files/{id}/complete` HEADs the object, checks `Content-Length == declared size`, then inserts the history item and broadcasts. Pending bytes count against the quota; the reaper drops overdue pendings and deletes their objects.

Without the completion step the server would list items whose upload never happened, and couldn't verify anything.

- *Alternative: S3 event notifications / polling HEAD* — not portable across S3-likes and adds delay.

### 3. Size and headers are bound into the signature

Presigned `PUT` cannot carry a size range, so the server adds `content-length`, `content-type: application/octet-stream` and `content-disposition: attachment; filename*=UTF-8''…` as **signed headers**; the response's `headers` map tells the client exactly what to send. The store rejects a mismatching length, and the object is stored with a binary type and attachment disposition, which neutralizes stored-XSS on the object-store origin without depending on `response-*` query overrides. The user-declared `content_type` is kept only as item metadata.

- *Alternative: presigned POST policy with `content-length-range`* — form uploads are awkward from `ureq` and support varies across S3-likes.
- Browsers set `Content-Length` themselves from the `Blob`; the web client sends the other two headers. `Content-Length` is a forbidden header in `fetch`/XHR, so it is listed in the response only for non-browser clients.

### 4. Path-style addressing, split `public_url` / `endpoint`

```toml
[server.storage]
public_url        = "https://s3.example.com"   # what clients reach; URLs are signed for this host
endpoint          = "http://127.0.0.1:3900"    # optional; server-side HEAD/DELETE/LIST. Defaults to public_url
region            = "garage"
bucket            = "copa"
access_key_id     = "GK…"
secret_access_key = "…"                        # or env COPA_S3_SECRET_ACCESS_KEY (wins)
key_prefix        = "copa/"
presign_ttl_secs  = 300

[server.namespaces.default]
history_limit    = 20
item_ttl_secs    = 86400
files            = true          # default true when [server.storage] exists
max_file_size    = 52428800      # 50 MiB
file_quota_bytes = 524288000     # 500 MiB
```

SigV4 signs the `Host`, so client URLs must be signed for the public host; path-style means one hostname/certificate/tunnel is enough (virtual-host style would need wildcard DNS). The server's own calls are signed separately for `endpoint`, so it does not need to hairpin through the proxy. Missing required keys abort startup; `http://` on a non-loopback `public_url` logs a warning.

Default `max_file_size` of 50 MiB stays below Cloudflare's 100 MB request-body cap, since multipart is out of scope.

### 5. History store replaces the single buffer

New library module `copa::history` (pure, no I/O, clock injected for tests):

- `Item { id, kind: Text(Vec<u8>) | File { key, name, content_type }, size, created_at, expires_at }`, ids are 128-bit random hex (`gen_token`).
- Per namespace: `VecDeque<Item>` newest-first, `pending: HashMap<id, PendingUpload>`, counters for file bytes.
- Operations return a list of *effects* (`Removed { id, reason, key: Option<String> }`) so the caller does the broadcasting and object deletion; the store itself never touches the network.
- Readers always filter on `expires_at > now`, so expiry is exact regardless of reaper cadence.
- Consecutive identical text refreshes the newest text item instead of adding one — the web app's live mode and `tmux` copy hooks otherwise fill the history with duplicates.

`GET /api/clipboard` = newest unexpired text item; `POST /api/clipboard` and `/ws` text frames = add text item. The existing `broadcast::Sender<Vec<u8>>` keeps feeding `/ws` with text only. Memory bound per namespace is `history_limit × size_limit`, unchanged in order of magnitude.

Storage code lives in `copa::storage` (config, signing, HEAD/DELETE/LIST). Route handlers move into `src/server/` modules so `main.rs` stays a thin entry point.

### 6. Separate `/ws/events` endpoint for structured events

`/ws` frames are raw content for existing clients, so JSON events get their own endpoint with a second per-namespace broadcast channel. Read permission required; inbound frames ignored. `/api/capabilities` lets clients detect all of this up front; a 404 there means "old server".

- *Alternative: `?events=1` on `/ws`* — same effect, but a distinct path is easier to reason about in proxy configs and tests.

### 7. Cleanup: reaper + reconcile, in-memory index

One background task:

- every 30 s: remove expired items and overdue pendings → broadcast `item_removed` → enqueue object keys for deletion; drain the delete queue (failed deletes stay queued).
- at startup and every 15 min: `ListObjectsV2` under `key_prefix`; delete every object not referenced by an item or pending upload. At startup the index is empty, so this purges leftovers from the previous run.

This keeps the "nothing outlives its item" guarantee without adding a database. Consequence: a prefix belongs to exactly one `copasrv`; documented, and the reference setup uses a dedicated bucket. A bucket lifecycle rule (expire after N days) is documented as a backstop for the case where `copasrv` is never started again.

- *Alternative: persist the index (JSON/SQLite)* — would let files survive restarts, but text items don't either today; revisit together if persistence is ever wanted.
- *Alternative: lifecycle rules only* — day granularity, not all S3-likes, no link to item deletion.

### 8. Auth and transport hardening

- Token comparison via `subtle::ConstantTimeEq` for all endpoints.
- New endpoints (`/api/history*`, `/api/files*`, `/api/capabilities`) accept the token only in `Authorization`; `?token=` stays for the legacy endpoints and WebSocket upgrades, where browsers cannot set headers.
- `server.allowed_origins` (optional list) replaces the `Any` CORS origin when set; default unchanged for compatibility. Bearer-token auth means permissive CORS is not a CSRF vector, but restricting it is recommended for internet-facing use.
- Download URL lifetime = `min(presign_ttl, expires_at − now)`.
- Log lines carry namespace, item id, size — never URLs, tokens or file names.
- File names: take the last path component, strip control characters, cap at 255 bytes, fall back to `file`. Done on the server on intake and again in `copacli get` before writing.

### 9. Client behaviour

- **copacli**: `put` = request → `ureq` PUT streaming from the file with the returned headers → complete. `get` = `GET /api/files/{id}` → stream to `<dest>.part` → rename; `create_new` unless `--force`. `history` list / `rm` / `clear`; `copy --item`. The names avoid the existing inverted `copy` (= download) / `paste` (= upload) pair.
- **Web**: `useCapabilities`, `useHistory` (list + `/ws/events` when Live is on), `useFileUpload` (XHR for upload progress). Drop zone wraps `ClipboardPanel`; `paste` handler takes `clipboardData.files`. Download navigates a temporary `<a>` to the presigned URL — attachment disposition makes it a save, and no CORS read is needed. Upload needs bucket CORS (`PUT`, headers `content-type`, `content-disposition`) for the app origin — set by the reference bootstrap.
- `web/public/sw.js` must pass through non-same-origin requests untouched.

### 10. Reference deployment layout

```
deploy/garage/
  docker-compose.yml     # garage (pinned tag), S3 port published on 127.0.0.1 only; profile "caddy" adds the proxy
  garage.toml            # single node, replication 1, secrets via env
  init.sh                # generate .env secrets, layout assign/apply, bucket, key, allow, CORS; idempotent; prints [server.storage]
  .env.example  .gitignore
  proxy/Caddyfile  proxy/haproxy.cfg  proxy/cloudflared.yml
  README.md
```

Proxy examples route two hostnames (`copa.example.com` → `127.0.0.1:8080`, `s3.example.com` → `127.0.0.1:3900`), keep `Host` intact, disable request buffering / raise body limits, and pass WebSocket upgrades. `make s3-up`, `make s3-down`, `make test-s3` wrap the compose file and the end-to-end script.

## Risks / Trade-offs

- [Default expiry changes long-standing "content stays forever" behaviour] → Called out as BREAKING in proposal and CHANGELOG; TTL is per-namespace configurable.
- [Restart drops history and purges all files under the prefix] → Consistent with today's in-memory model; documented prominently; persistence listed as future work.
- [Two servers sharing a prefix delete each other's objects] → Documented; reference setup uses a dedicated bucket; `key_prefix` is configurable.
- [Presigned URL leak via logs, proxies or browser history] → Short TTL, single object/verb, signed size; never logged by copa; web app never stores them; docs require HTTPS.
- [An S3-like that ignores signed `content-length` would let a holder of an upload URL exceed the declared size] → Completion re-checks size via HEAD and deletes on mismatch; quota bounds the damage to one transient object. Garage and AWS enforce it; verified by the integration test.
- [Store unreachable → deletes pile up] → Bounded retry queue plus reconcile; item is hidden immediately regardless.
- [Bucket CORS misconfiguration is the most likely setup failure for browser uploads] → Bootstrap script sets it; troubleshooting section in docs; the web app surfaces a specific hint when the PUT fails before any response.
- [Files are readable by the object-store operator and anyone holding a read token] → Stated in docs; E2E encryption is a non-goal for now.
- [Clock skew between `copasrv` and the store breaks signatures] → Documented (NTP); error surfaced verbatim from the store on HEAD failures.

## Migration Plan

1. Upgrade `copasrv`; with no config changes it behaves as before plus history and 24 h expiry. Operators who rely on indefinite retention set a large `item_ttl_secs`.
2. To enable files: start the object store (`deploy/garage`), add `[server.storage]`, restart.
3. Rollback: remove `[server.storage]` (files off) or downgrade the binary; objects left in the bucket can be removed with the store's own tooling. No on-disk state to migrate either way.

## Open Questions

- Exact Garage image tag to pin and whether its CORS setup is best done via `aws s3api put-bucket-cors` or Garage's CLI in `init.sh` — decided while writing the bootstrap; does not affect specs.
- Reconcile interval (15 min) and reaper interval (30 s) as constants vs. config keys — start as constants.
