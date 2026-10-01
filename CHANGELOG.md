# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- [ ] TLS/SSL support for HTTPS
- [ ] Multiple clipboard slots/history
- [ ] Clipboard content encryption
- [ ] WebSocket support for live updates
- [ ] Browser extension
- [ ] Mobile app
- [ ] Clipboard content search
- [ ] Content type detection (text/image/file)
- [ ] Persistent storage backend (SQLite/PostgreSQL)
- [ ] User authentication and multi-user support
- [ ] Rate limiting and quota management
- [ ] Clipboard expiration/TTL
- [ ] Audit logging
- [ ] Prometheus metrics endpoint
- [ ] Docker container image
- [ ] Systemd service file
- [ ] Package for Homebrew, AUR, apt, etc.

### Known Limitations
- Server-side clipboard is in-memory only (resets on restart)
- Single server token (no per-user auth)
- No clipboard history/versioning
- Text-only (no binary/image support)
- No clipboard encryption at rest
- No rate limiting
- No persistent storage

---

[Unreleased]: https://github.com/yourusername/copa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yourusername/copa/releases/tag/v0.1.0
