# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `copasrv` no longer embeds a legacy UI (`web/ui.html` removed). It serves the web app from `--static-dir` / `COPA_STATIC_DIR`, defaulting to `<exe dir>/../share/copa/dist`, then `~/.local/share/copa/dist`, and exits with an error listing the searched paths if none has an `index.html`.
- `copasrv` prints the web app directory at startup.
- `make install-web` asks before removing the old installed frontend (`YES=1` to skip).

## [0.4.0] - 2026-11-09

### Added
- **Embeddable widget** (`web-widget/`): a Preact component and `<copa-share>` custom element (Shadow DOM,
  themable with CSS variables) that adds text and file sharing to any web application — configured by one
  JSON file (`copa-widget.schema.json`), with content-type aware previews, drag/drop/paste upload to S3,
  live updates, and a typed host API (`share`, `paste`, events). Built by `make build-widget`; shipped in
  `bin/frontend/widget/` by `make dist`. See `docs/WIDGET.md`.
- **Token-service sign-in** for the widget (`auth.method = "oauth2"`): pop-up (or full-page redirect) login at
  a central OAuth2/OIDC token service, verifier-bound hand-off, silent renewal with rotating refresh tokens,
  COOP-safe polling fallback, optional persistence.
- **Trusted issuers** in copasrv (`[server.auth.issuers.<name>]`): JWT access tokens are verified against the
  issuer's JWKS (ES256/RS256/…; never `HS*` or `none`), with issuer/audience/expiry checks, rate-limited key
  refresh, stale-on-failure, and claim → namespace/access mapping (`403` for a valid token without access).
- **Device pairing** (`[server.pairing]`): operator-opened windows, SPAKE2 short code or ECDH fingerprint
  approval, time-limited revocable device tokens (optional sliding renewal), per-source rate limit;
  `copacli pair open|pending|approve|reject|devices|revoke`.
- `POST /api/events/ticket`: single-use event-stream tickets so no credential has to go into a WebSocket URL;
  the stream ends when the credential that opened it expires.
- `token-issuer/`: an independent token service for testing (fake users or upstream OIDC such as dex, JWKS,
  key rotation, fault injection), `make token-issuer`.
- `web-core/`: the HTTP/upload client shared by the web app and the widget.
- Ansible: opt-in management of the `[server.storage]` block on a running instance
  (`-e copa_storage_enabled=true` / `--tags storage`, removal with
  `copa_storage_remove=true`). Only the marked block is touched, a timestamped
  `config.toml.<ts>.bak` is made first, and the S3 secret goes to a `0600` `storage.env`
  loaded as `COPA_S3_SECRET_ACCESS_KEY` — see `ansible/README.md`
- `make verify-s3` to try file sharing by hand on the local network (optional HTTPS)

### Changed
- `Cargo.lock` is now tracked and dependencies were updated
- Web app: yarn 4.18.1 and all dependencies bumped to latest
- The `/ws/events` stream subscribes before the upgrade completes, so an item pushed right after connecting
  is no longer missed.
- Clipboard 401 answers now carry a JSON content type; a valid credential without access to the namespace
  gets `403`.
- Web app: its API client and upload code moved to `web-core/` (no behaviour change).

## [0.3.0] - 2026-11-05

### Changed
- **BREAKING (behaviour):** clipboard content now expires. Every item lives for
  `item_ttl_secs` (default 86400 = 24 h, per namespace); after that
  `GET /api/clipboard` returns an empty body. Previously content stayed until
  the server restarted. Set a larger `item_ttl_secs` to keep content longer.
- Tokens are compared in constant time; an empty token never matches.
- `copasrv --config` / `COPA_CONFIG` is now honoured (it was parsed but ignored).
- A write-only WebSocket session on `/ws` now stays open instead of closing
  immediately.
- `copacli` and `copa-tray` trust the system certificate store for HTTPS
  (and `SSL_CERT_FILE`), so servers behind a private CA work.

### Added
- MQTT clipboard sharing in `copacli` and `copa-tray`
- Ansible deployment (`ansible/`) and `make dist` cross-builds
- Server-side clipboard history: `history_limit` items per namespace (default 20),
  `GET /api/history`, `GET`/`DELETE /api/history/{id}`, `DELETE /api/history`,
  optional `X-Copa-TTL` header, and a JSON event stream on `/ws/events`
- File sharing through S3-compatible storage with presigned URLs
  (`[server.storage]`, `POST /api/files`, `POST /api/files/{id}/complete`,
  `GET /api/files/{id}`), per-namespace `max_file_size` and `file_quota_bytes`;
  expired, evicted and deleted files are removed from the object store, and
  orphaned objects are swept at startup and periodically — see `docs/FILES.md`
- `GET /api/capabilities`
- `copacli put`, `copacli get`, `copacli history` (`rm`, `clear`), `copacli copy --item`
- Web app: history list, drag-and-drop / picker / paste file upload with progress
- `server.allowed_origins` to restrict CORS
- Reference Garage backend in `deploy/garage/` with Caddy, HAProxy and
  cloudflared examples; `make s3-up`, `make s3-down`, `make test-s3`

## [0.2.0]

### Changed
- Split into `copasrv` (server, no tmux dependency) and `copacli` (client); the single
  `copa serve` / `copa cli` binary is gone

### Added
- Named clipboard namespaces with per-namespace `size_limit` and separate
  `read_token` / `write_token` / `rw_token`, selected with `X-Copa-Namespace`
- WebSocket push on `/ws` and `copacli watch` (auto-reconnect with exponential backoff)
- Vite + Preact + TypeScript web app (`web/`, served with `--static-dir` / `COPA_STATIC_DIR`),
  with a server list, Live toggle, shareable token links, installable PWA
- Web app MQTT sharing (AES-256-GCM, interoperable with `copacli mqtt-*`), QR display and
  scanner for sharing servers and AES keys, and GPS location sharing (geo:, Google Maps,
  Mapy.cz, Apple Maps, OpenStreetMap)
- `copa-tray`: Windows system-tray client — see `docs/WIN_USE.md` (`make tray-windows`)

## [0.1.0]

### Added
- Initial release
- HTTP server with token authentication
- Dual clipboard: tmux buffer + server-side clipboard
- Web UI with light/dark/auto themes
- CLI client with `copy` and `paste` subcommands
- Short aliases: `up` (paste) and `down` (copy)
- Multi-remote configuration support
- File I/O: `--input` and `--output` flags
- System clipboard integration: `--input-cmd` and `--output-cmd`
- Environment variable support for all config options
- TOML configuration file at `~/.config/copa/config.toml`
- CORS support for split UI/API deployments
- Verbose logging for CLI operations
- Server-side request logging
- Auto-pull feature in web UI (2/5/10/30s intervals)
- Token-in-fragment URL scheme (prevents server-side logging)
- Custom headers support for remotes
- Stdin/stdout pipe support
- tmux session targeting support

### API Endpoints
- `GET /api/clipboard` — Retrieve server clipboard (plain text)
- `POST /api/clipboard` — Store server clipboard (plain text)
- `GET /api/buffer` — Retrieve tmux buffer (JSON)
- `POST /api/buffer` — Set tmux buffer (plain text body)
- `GET /` — Web UI

### CLI Commands
- `copa serve` — Start HTTP server
- `copa cli copy` — Download from remote to tmux buffer
- `copa cli paste` — Upload from tmux buffer to remote
- `copa cli down` — Alias for `copy`
- `copa cli up` — Alias for `paste`
- `copa --generate-token` — Generate auth token
- `copa --print-config-path` — Show config file location

### Configuration
- Server config: port, bind, token, socket, session
- CLI config: default_remote, remotes (url, token, headers)
- Multi-remote support with named configurations
- Config precedence: CLI args > env vars > config file > defaults

### Integrations
- macOS clipboard: `pbcopy` / `pbpaste`
- X11 clipboard: `xsel` / `xclip`
- Wayland clipboard: `wl-copy` / `wl-paste`
- tmux buffer integration
- File input/output
- Stdin/stdout pipes

### Documentation
- Comprehensive README with examples
- tmux integration guide with keybinding recipes
- Configuration examples
- API documentation
- Troubleshooting guide

### Security
- Token-based authentication
- URL fragment tokens (never logged)
- CORS headers for cross-origin access
- Localhost-only binding by default

## [0.1.0] - 2024-01-XX

### Project Renamed
- Renamed from `tmux-clipboard` to `copa`
- Binary renamed from `tmux-clipboard` to `copa`
- Updated all references in code and documentation

### Changed
- Restructured config file format with `[server]` and `[cli]` sections
- Improved error messages with context
- Added verbose CLI output with progress indicators (→, ←, ✓)
- Changed default behavior to show help when no subcommand provided

### Fixed
- Config file parsing for TOML structure
- Remote selection from config
- Default remote resolution

## Future Considerations

### Potential Features
- [ ] TLS/SSL termination in `copasrv` (use a reverse proxy today)
- [ ] Clipboard content encryption (MQTT payloads are already AES-256-GCM encrypted)
- [ ] Browser extension
- [ ] Mobile app
- [ ] Clipboard content search
- [ ] Persistent storage backend (SQLite/PostgreSQL)
- [ ] User authentication and multi-user support
- [ ] Rate limiting and quota management beyond per-namespace size, history and file quotas
- [ ] Audit logging
- [ ] Prometheus metrics endpoint
- [ ] Docker container image for `copasrv`
- [ ] Package for Homebrew, AUR, apt, etc.

### Known Limitations
- Clipboard text and history are in-memory only (reset on restart); files in the object store
  are swept at startup
- Single token per role and namespace (no per-user auth)
- Text clipboard only; files are shared through S3-compatible storage, not the clipboard
- No clipboard encryption at rest on the server
- No request rate limiting
- `copa-tray` is Windows-only

---

[Unreleased]: https://github.com/PexMor/copa/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PexMor/copa/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PexMor/copa/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PexMor/copa/releases/tag/v0.1.0
