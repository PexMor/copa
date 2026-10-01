# Tasks

## 1. Setup and module layout

- [x] 1.1 Add `rusty-s3` and `subtle` to `Cargo.toml` (plus `tempfile` as a dev-dependency); verify `cargo build` succeeds for `copasrv` and `copacli` and `make tray-windows` still compiles if the toolchain is installed
- [x] 1.2 Split `src/main.rs` into `src/server/{config,auth,clipboard,ws,static_assets}.rs` with no behaviour change; verify `cargo build` passes and a manual `curl` POST/GET on `/api/clipboard` plus a `websocat` on `/ws` behave as before
- [x] 1.3 Replace `==` token checks in `can_read` / `can_write` with constant-time comparison and add unit tests for rw/read/write/empty-token cases; verify `cargo test` passes

## 2. History store (text items, expiry, limits)

- [x] 2.1 Implement `copa::history` (items, newest-first deque, `history_limit` eviction, TTL with client-requested clamp, identical-text refresh, effects list, injected clock); verify with unit tests covering each scenario in `specs/clipboard-history` for limit, TTL, clamp, dedup and expired-item filtering
- [x] 2.2 Add `history_limit` and `item_ttl_secs` to namespace config with defaults (20 / 86400), reject TTL ≤ 0 at startup; verify with a config-parsing unit test and by starting `copasrv` with an invalid TTL and observing a non-zero exit with a clear message
- [x] 2.3 Rewire `GET`/`POST /api/clipboard` and `/ws` onto the history store (newest unexpired text; `X-Copa-TTL` header honoured); verify with handler-level tests that an old-style push/pull round-trips and that an expired newest text yields an empty 200 body
- [x] 2.4 Add the background reaper (30 s tick) removing expired items; verify with a test using a short TTL that the item disappears from the store and an effect with reason `expired` is produced
- [x] 2.5 Update `README.md`, `config.toml.example` and `CHANGELOG.md` for history limit, TTL and the BREAKING expiry default; verify the documented config example parses with `copasrv --config <example>`

## 3. History API, events and capability discovery

- [x] 3.1 Implement `GET /api/history`, `GET /api/history/{id}`, `DELETE /api/history/{id}`, `DELETE /api/history` with header-only auth; verify with handler tests for ordering, preview length ≤ 200, 401 on wrong permission, 404 across namespaces and 401 for `?token=`-only requests
- [x] 3.2 Implement `/ws/events` with a per-namespace JSON event channel (`item_added`, `item_removed` with reason); verify with an integration test that connects, pushes text, deletes it, and asserts both frames, and that `/ws` receives only the text frame
- [x] 3.3 Implement `GET /api/capabilities`; verify the JSON reports `history`, `history_limit`, `item_ttl_secs` and `files: false` on a server without storage
- [x] 3.4 Add optional `server.allowed_origins` CORS restriction (default unchanged); verify with `curl -H 'Origin: …' -i` that an unlisted origin gets no `Access-Control-Allow-Origin` when the list is set
- [x] 3.5 Document the new endpoints and event frames in the README API reference; verify each documented `curl` example runs as written against a local server

## 4. Reference Garage backend

- [x] 4.1 Create `deploy/garage/` with `docker-compose.yml` (pinned Garage image, S3 port on `127.0.0.1` only, admin/RPC unpublished), `garage.toml`, `.env.example` and `.gitignore`; verify `docker compose up -d` starts a healthy container and `ss -ltn` shows only the loopback S3 port
- [x] 4.2 Write idempotent `init.sh` (generate secrets into `.env`, layout, bucket, bucket-scoped key, CORS for configured origins, print `[server.storage]` block); verify running it twice succeeds, an unsigned `curl` to the bucket is denied, and `git status` shows no secret files
- [x] 4.3 Add `make s3-up` / `make s3-down` targets and list them in `make help`; verify both run cleanly from the repo root

## 5. Storage layer and file API

- [x] 5.1 Implement `copa::storage` config (`[server.storage]`, env override for the secret, required-key validation, http-on-public-host warning); verify with unit tests for missing keys, env precedence and the warning condition
- [x] 5.2 Implement presigned PUT (signed `content-length`, `content-type`, `content-disposition`), presigned GET, and server-side HEAD / DELETE / LIST against `endpoint`; verify with a unit test of URL shape (path-style, public host, expiry) and an `#[ignore]` integration test that round-trips an object against the Garage reference backend
- [x] 5.3 Add file items and pending uploads to the history store (`max_file_size`, `file_quota_bytes` including pending bytes, deadline, filename sanitization); verify with unit tests for 413/507 conditions, pending expiry freeing quota, and traversal/control-character names
- [x] 5.4 Implement `POST /api/files`, `POST /api/files/{id}/complete`, `GET /api/files/{id}` with header-only auth, namespace `files` opt-out and download TTL capped by item expiry; verify with handler tests for 401/404/409/413/507 paths and, against Garage, that a wrong-length PUT is rejected and complete-without-upload returns 409
- [x] 5.5 Wire object deletion into expiry, eviction, delete and clear, with a retry queue; add startup and periodic reconcile of the key prefix; verify against Garage that an expired file's key returns 404 within 60 s and that objects placed under the prefix before startup are gone after startup
- [x] 5.6 Ensure log lines for file operations exclude URLs, tokens and file names; verify by running an upload/download and grepping server stderr for `X-Amz-Signature` and the token (no matches)
- [x] 5.7 Write `docs/FILES.md` (enable steps, all options with defaults, flow diagram, limits, restart/prefix caveats) and update `config.toml.example`; verify defaults in the doc equal `GET /api/capabilities` from a server started with no overrides

## 6. copacli

- [x] 6.1 Add `put <FILE>` with `--name`, `--ttl`, streaming upload and completion, and clear errors for unsupported server / 413 / 507; verify against the Garage setup that `put` prints an id and exits 0, and exits non-zero with a message against a server without storage
- [x] 6.2 Add `get [ID]` with `-o`, `--force`, `.part` temp file and basename-only destination; verify byte-identical round-trip via `sha256sum`, refusal to overwrite without `--force`, and a unit test that hostile names resolve inside the target directory
- [x] 6.3 Add `history` (table and `--json`), `history rm`, `history clear` and `copy --item <ID>`; verify list order and remaining-lifetime output manually, that `rm` removes the item, and that `--item` on a file id exits non-zero pointing to `get`
- [x] 6.4 Document the new commands in the README copacli section and the usage comment in `config.toml.example`; verify each documented command runs as written

## 7. Web app

- [x] 7.1 Add types plus `useCapabilities` and `useHistory` hooks (list, refresh, `/ws/events` when Live is on) and a history list component with kind, name/preview, size, time remaining, copy/load, download and delete; verify with `yarn build` and manually that an item pushed by `copacli` appears live and disappears on expiry
- [x] 7.2 Add drop zone, file picker and paste-file handling with per-file progress and client-side `max_file_size` check, hidden when the server lacks file support or the server is MQTT; verify manually with drag-and-drop, picker and pasted image against the Garage setup, and that controls are absent against a server without storage
- [x] 7.3 Implement download via temporary anchor to a freshly requested presigned URL, never persisting URLs; make `web/public/sw.js` bypass cross-origin requests; verify the file saves under its original name and DevTools shows no object-store entries in Cache Storage or IndexedDB
- [x] 7.4 Surface a specific hint when the upload PUT fails without a response (likely bucket CORS) and document it in `docs/FILES.md` troubleshooting; verify by temporarily removing the origin from bucket CORS
- [x] 7.5 Rebuild and publish the bundle with `make deploy-docs` and note the web features in the README Web UI section; verify `docs/app/` loads and shows the history panel against a local server

## 8. Reverse proxy examples and security documentation

- [x] 8.1 Add `deploy/garage/proxy/Caddyfile` and a compose `caddy` profile fronting copasrv and the S3 API on two hostnames; verify with local hostnames (Caddy internal TLS) that `copacli put`/`get`, `/ws` and `/ws/events` work through the proxy
- [x] 8.2 Add `proxy/haproxy.cfg` and `proxy/cloudflared.yml` examples preserving Host/path/query with adequate body limits and WebSocket support; verify HAProxy config with `haproxy -c -f` and the cloudflared file with `cloudflared tunnel ingress validate`
- [x] 8.3 Write `deploy/garage/README.md` and the security checklist in `docs/FILES.md` (HTTPS, loopback binds, bucket-scoped key, CORS / `allowed_origins`, body-size limits incl. Cloudflare, token rotation, one prefix per instance, lifecycle-rule backstop, clock sync); verify every checklist item maps to a concrete config line or command in the reference files, and update the README Security section to link to it

## 9. End-to-end verification

- [x] 9.1 Add `scripts/test-s3.sh` and `make test-s3` that start Garage, run `copasrv` with a short TTL, exercise put/get/history/expiry/reconcile via `copacli` and `curl`, and assert the bucket is empty at the end; verify the script exits 0 on a clean checkout with Docker available
- [x] 9.2 Run `cargo test`, `cargo test -- --ignored` (with Garage up), `cd web && yarn build`, and an old-client compatibility check (previous `copacli` release or raw `curl` against `/api/clipboard` and `/ws`); verify all pass and record the results in the change's PR description
- [x] 9.3 Run `openspec validate add-file-clipboard-and-history --strict`; verify it reports no errors
