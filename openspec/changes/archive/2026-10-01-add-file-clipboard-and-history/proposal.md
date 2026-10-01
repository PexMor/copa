# Proposal

## Why

copa today shares exactly one small text buffer per namespace: a new push overwrites the previous one, nothing expires, and files cannot be shared at all (the 16 KB in-memory limit and text-only WebSocket frames rule it out). Users want to drop a file in the browser or `put` one from the terminal and fetch it on another machine, and to get back an item they pushed a few pushes ago — without turning `copasrv` into a file server that buffers large bodies in memory.

## What Changes

- **File clipboard items via S3-compatible storage (opt-in).** A new `[server.storage]` config section gives `copasrv` an S3-like base URL, bucket and credentials. `copasrv` becomes the dedicated API that authorizes a request with the existing namespace tokens and hands back short-lived presigned URLs; clients upload and download file bytes directly to/from the object store. File bytes never pass through `copasrv`, and S3 credentials never leave it.
- **Server-side clipboard history.** Each namespace keeps a bounded list of recent items (text and files) instead of a single buffer. Clients can list items, fetch an older one by id, and delete items.
- **Expiry of every item.** Each item carries an expiry time (namespace TTL, optionally shortened per item). Expired items stop being served immediately and are removed by the server, including the backing S3 object. Orphaned objects (abandoned uploads, objects left by a restart) are swept as well.
- **`copacli` file and history commands**: `put <file>`, `get [id]`, `history` (list / `rm` / `clear`), and `copy --item <id>` for older text items.
- **Web app**: drag-and-drop, file picker and paste-a-file upload with progress, plus a history list with download / copy / delete and time-to-expiry.
- **Opt-in JSON event stream** (`/ws/events`) announcing added and removed items, so file-aware clients stay live without changing the existing text-frame `/ws` protocol.
- **Reference object-store deployment**: a dockerized Garage setup under `deploy/garage/` (compose file, bootstrap script creating a bucket and a bucket-scoped key, CORS setup) with reverse-proxy examples for Caddy, HAProxy and cloudflared, and a documented security checklist.
- **Hardening that ships with the feature**: constant-time token comparison, header-only auth on the new endpoints, optional `allowed_origins` CORS restriction, signed upload size / headers, download-as-attachment, filename sanitization, per-namespace file size and storage quota.
- **BREAKING (behavioral)**: clipboard content now expires. With the default TTL (24 h) `GET /api/clipboard` returns an empty body once the newest text item has expired, where previously content lived until the server restarted. The TTL is configurable per namespace.

Existing endpoints (`GET`/`POST /api/clipboard`, `/ws`), the existing CLI commands and `copa-tray` keep working unchanged against a new server, and the feature is entirely absent when `[server.storage]` is not configured (history and expiry of text items still apply).

Out of scope: multipart/resumable uploads, end-to-end encryption of files, file transfer over the MQTT transport, file support in `copa-tray` and in the embedded legacy `web/ui.html`, persistence of history across server restarts, rate limiting.

## Capabilities

### New Capabilities

- `clipboard-history`: Per-namespace server-side history of clipboard items — retention limits, item expiry and removal, listing / retrieval / deletion API, item events, and how the existing single-buffer API maps onto the history.
- `file-transfer`: File clipboard items backed by S3-compatible storage — storage configuration, presigned upload/download API, upload verification, size and quota limits, object lifecycle and cleanup, and the security properties of the presigned-URL flow.
- `cli-client`: `copacli` behaviour for uploading and downloading files and for working with history items.
- `web-client`: Web app behaviour for drag-and-drop / picker / paste file upload, downloading files and browsing history.
- `object-storage-deployment`: The reference dockerized Garage backend and the requirements for running the object store and `copasrv` behind an internet-facing reverse proxy safely.

### Modified Capabilities

None — `openspec/specs/` is empty; no existing capability specs to modify.

## Impact

- **Server** (`src/main.rs`, new modules under `src/`): namespace state changes from a single `Vec<u8>` to a history store; new routes `/api/history`, `/api/history/{id}`, `/api/files`, `/api/files/{id}`, `/api/files/{id}/complete`, `/api/capabilities`, `/ws/events`; background expiry/reconcile task; new config keys under `[server]`, `[server.storage]` and `[server.namespaces.*]`.
- **CLI** (`src/bin/copacli.rs`): new subcommands and a streaming upload/download path.
- **Web** (`web/src/`): new hooks/components for files and history; `web/public/sw.js` must not intercept object-store requests; `docs/app/` bundle refresh.
- **Dependencies**: an S3 SigV4 presigning crate (`rusty-s3`), `subtle` for constant-time comparison; no new web dependencies expected.
- **New files**: `deploy/garage/` reference deployment, `docs/FILES.md` (setup + security), integration test script.
- **Docs/config**: `README.md`, `config.toml.example`, `CHANGELOG.md`, `Makefile` targets.
- **Operations**: operators enabling files must run an S3-compatible store reachable by clients at the configured base URL, with bucket CORS allowing the web app origin. One bucket key-prefix must be used by exactly one `copasrv` instance (the orphan sweep deletes unknown objects under it).
