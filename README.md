# copa

**Clipboard over HTTP** — a minimal, token-authenticated clipboard server with named namespaces, WebSocket push notifications, and a modular client.

## Architecture

| Binary | Role |
|--------|------|
| **`copasrv`** | HTTP/WebSocket server. Manages named clipboard namespaces and their history in memory; hands out presigned URLs for files. No tmux dependency. |
| **`copacli`** | Local client. One-shot copy/paste, file `put`/`get`, `history`, and persistent `watch` mode. Handles all tmux, file, and platform-clipboard I/O. |
| **`copa-tray`** | Windows system-tray client (separate build). Supports both HTTP and MQTT clipboard sharing. |

The separation keeps the server's attack surface small — it stores bytes and pushes WebSocket events; it never touches tmux or runs subprocesses. File contents never pass through it either: clients upload and download directly to an S3-compatible store using short-lived presigned URLs.

## Features

- Named clipboard **namespaces** — independent buffers, each with its own size limit (default 16 KB) and separate read / write / read-write tokens
- **WebSocket push** — clients receive updates instantly without polling (`/ws`)
- **REST API** — simple GET/POST on `/api/clipboard` with `X-Copa-Namespace` header
- **`copacli watch`** — persistent background bridge: WebSocket → tmux buffer (or any command), auto-reconnects
- **`copacli copy/paste`** — one-shot download/upload with full I/O routing (tmux, file, stdout, platform clipboard tools)
- **MQTT clipboard sharing** — `copacli mqtt-pub/mqtt-get/mqtt-sub` and copa-tray Upload/Download menu items; AES-256-GCM encrypted, interoperable with the web app; works with any MQTT broker over `mqtt://`, `mqtts://`, `ws://`, `wss://`
- **Clipboard history** — each namespace keeps its recent items (default 20); list them, fetch an older one, delete them. Every item expires (default 24 h)
- **File sharing** (optional) — `copacli put` / `get`, drag-and-drop in the web app; files go straight to S3-compatible storage via presigned URLs and are removed when they expire. See [docs/FILES.md](docs/FILES.md)
- **Web UI** — namespace selector, Live WebSocket toggle, auto-pull, shareable token links, history list, file drop zone

## Installation

```bash
# Build and install copasrv + copacli to ~/bin
make install

# Or just build
cargo build --release
# → target/release/copasrv
# → target/release/copacli

# Generate a token
copasrv --generate-token
```

## Quick Start

### 1. Configure

```bash
mkdir -p ~/.config/copa
cat > ~/.config/copa/config.toml <<'EOF'
[server.namespaces.default]
rw_token = "REPLACE_WITH_YOUR_TOKEN"

[cli]
default_remote = "local"

[cli.remotes.local]
url   = "http://127.0.0.1:8080"
token = "REPLACE_WITH_YOUR_TOKEN"
EOF
```

Generate a token: `copasrv --generate-token`

### 2. Start the server

```bash
copasrv
# listening on http://127.0.0.1:8080
```

### 3. Use the web UI

Open `http://127.0.0.1:8080/#token=YOUR_TOKEN` — the token lives only in the URL fragment and is never sent to server logs.

### 4. Use the CLI

```bash
# Upload tmux buffer → server
copacli paste -r local

# Download server → tmux buffer
copacli copy -r local

# Live bridge: server WebSocket → tmux buffer (runs forever, auto-reconnects)
copacli watch -r local
```

## Configuration

**File:** `~/.config/copa/config.toml`

```toml
[server]
port = 8080
bind = "127.0.0.1"   # change to 0.0.0.0 to expose on the network

# Optional: restrict CORS to the origin(s) serving the web app (default: any).
# allowed_origins = ["https://copa.example.com"]

# Named namespaces — each is an independent clipboard with its own history.
# size_limit is in bytes (default: 16384 = 16 KB) and applies to text items.
# Provide any combination of read_token, write_token, rw_token.
[server.namespaces.default]
size_limit    = 16384
rw_token      = "your-rw-token"
history_limit = 20        # items kept; the oldest is evicted (default 20)
item_ttl_secs = 86400     # every item expires after this long (default 24 h)
# files            = false       # opt this namespace out of file sharing
# max_file_size    = 52428800    # 50 MiB per file
# file_quota_bytes = 524288000   # 500 MiB of files per namespace

# Optional: file sharing through S3-compatible storage — see docs/FILES.md.
# `make s3-up` starts a local Garage and prints this block.
# [server.storage]
# public_url        = "https://s3.example.com"   # what clients reach
# endpoint          = "http://127.0.0.1:3900"    # what copasrv uses (default: public_url)
# bucket            = "copa"
# access_key_id     = "GK..."
# secret_access_key = "..."                      # or env COPA_S3_SECRET_ACCESS_KEY

[server.namespaces.shared]
size_limit  = 4096
read_token  = "reader-token"
write_token = "writer-token"

# Legacy shorthand: equivalent to [server.namespaces.default] rw_token
# token = "your-token"

[cli]
default_remote = "local"

[cli.remotes.local]
url   = "http://127.0.0.1:8080"
token = "your-rw-token"

[cli.remotes.work]
url   = "https://copa.example.com"
token = "work-token"
headers = { "X-Custom-Header" = "value" }

# MQTT servers — each is an independent broker/topic/key combination.
# Used by mqtt-pub, mqtt-get, mqtt-sub (copacli) and the tray Upload/Download items.
[cli]
default_mqtt_server = "mybroker"

[cli.mqtt_servers.mybroker]
broker_url       = "wss://broker.emqx.io:8084/mqtt"
topic            = "copa/clipboard/mykey"
aes_key          = "V2hhdCBhcmUgeW91IGxvb2tpbmcgYXQ/ICAgIDMyYg=="
# max_message_size = 65535  # default
# client_id        = "myhost"  # random if omitted
```

### Environment Variables

```bash
COPA_PORT=9000
COPA_BIND=0.0.0.0
COPA_TOKEN=my-token        # legacy: sets default namespace rw_token
COPA_REMOTE=work           # copacli default remote
COPA_NAMESPACE=shared      # copacli default namespace
COPA_SOCKET=/tmp/tmux-1000/default
COPA_SESSION=main
COPA_CONFIG=/path/to/config.toml
COPA_S3_SECRET_ACCESS_KEY=...   # copasrv: overrides [server.storage] secret_access_key

# MQTT overrides (copacli + copa-tray)
COPA_MQTT_SERVER=mybroker  # named entry from [cli.mqtt_servers]
COPA_MQTT_BROKER=wss://broker.example.com:8084/mqtt
COPA_MQTT_TOPIC=copa/clipboard/mykey
COPA_MQTT_KEY=<base64-or-hex-or-base58 AES-256 key>
```

Precedence: CLI args > environment variables > config file > defaults.

## copasrv — Server

```bash
# Start (reads ~/.config/copa/config.toml)
copasrv

# Override port / bind
copasrv --port 9000 --bind 0.0.0.0

# Legacy: start with a single token (auto-creates "default" namespace)
copasrv --token secret123

# Utilities
copasrv --generate-token
copasrv --print-config-path
```

## copacli — Client

### copy — download from server

```bash
# Default output: tmux buffer (auto-detected from $TMUX)
copacli copy -r local

# Platform clipboard tools
copacli copy -r local --output-cmd pbcopy        # macOS
copacli copy -r local --output-cmd 'xsel -ib'    # X11
copacli copy -r local --output-cmd wl-copy        # Wayland

# File / stdout
copacli copy -r local -o data.txt
copacli copy -r local -o -

# Specific namespace
copacli copy -r local --namespace shared
```

### paste — upload to server

```bash
# Default input: tmux buffer
copacli paste -r local

# Platform clipboard tools
copacli paste -r local --input-cmd pbpaste        # macOS
copacli paste -r local --input-cmd 'xsel -ob'     # X11
copacli paste -r local --input-cmd wl-paste        # Wayland

# File / stdin
copacli paste -r local -i data.txt
copacli paste -r local -i -
echo "data" | copacli paste -r local

# Literal text
copacli paste -r local "hello world"

# Specific namespace
copacli paste -r local --namespace shared
```

### watch — persistent WebSocket bridge

Stays running, receives server updates, and routes them to the configured output. Auto-reconnects with exponential backoff.

```bash
# WebSocket → tmux buffer (default)
copacli watch -r local

# WebSocket → macOS clipboard
copacli watch -r local --output-cmd pbcopy

# WebSocket → X11 clipboard
copacli watch -r local --output-cmd 'xsel -ib'

# Watch a specific namespace
copacli watch -r local --namespace shared

# Without a named remote (direct server URL + token)
copacli watch --server ws://localhost:8080/ws --token TOKEN

# Tune reconnect backoff (default max: 30s)
copacli watch -r local --max-backoff 60
```

**Tip:** Run `copacli watch` as a background service or in a tmux window to get automatic clipboard sync whenever anyone pushes to the server.

### mqtt-pub — publish to an MQTT broker

Reads input (same sources as `paste`), encrypts with AES-256-GCM if a key is set, and publishes with `retain=true` QoS 1 so any subscriber can retrieve the latest value at any time.

```bash
# From tmux buffer (default)
copacli mqtt-pub -m mybroker

# Literal text
copacli mqtt-pub -m mybroker "hello world"

# From stdin
echo "data" | copacli mqtt-pub -m mybroker -i -

# Without a config entry
copacli mqtt-pub --broker wss://broker.emqx.io:8084/mqtt --topic copa/test \
  --key "$(openssl rand -base64 32)" "secret text"
```

### mqtt-get — download the retained message

Connects, subscribes, receives the single retained message (last ever published), decrypts, and routes to output.

```bash
# To tmux buffer
copacli mqtt-get -m mybroker

# To stdout
copacli mqtt-get -m mybroker -o -

# To macOS clipboard
copacli mqtt-get -m mybroker --output-cmd pbcopy
```

### mqtt-sub — persistent subscription loop

Stays connected (or auto-reconnects with exponential backoff) and routes every incoming message to the configured output — equivalent of `watch` but over MQTT.

```bash
# Print every incoming message to stdout
copacli mqtt-sub -m mybroker -o -

# Route to tmux buffer on every message
copacli mqtt-sub -m mybroker
```

All three MQTT subcommands accept the same `-x`/`-S`/`-o`/`--output-cmd`/`-i`/`--input-cmd` routing flags as `copy`/`paste`.

### put / get — share files

Needs file sharing enabled on the server ([docs/FILES.md](docs/FILES.md)). The file goes straight from disk to the object store; `copasrv` only authorizes it.

```bash
# Upload a file; prints the new item id on stdout
copacli put -r local report.pdf

# Store under a different name, expire after 10 minutes
copacli put -r local --name notes.txt --ttl 600 draft.txt

# Download the newest file into the current directory, under its own name
copacli get -r local

# A specific item, into a directory / to a file / to stdout
copacli get -r local ID -o ~/Downloads
copacli get -r local ID -o out.pdf
copacli get -r local ID -o - | tar tz

# Existing files are never overwritten unless you say so
copacli get -r local --force
```

### history — older items

```bash
# Newest first: id, kind, size, time until expiry, name or preview
copacli history -r local

# The server's JSON listing, for scripts
copacli history -r local --json

# Fetch an older text item (same output routing as copy)
copacli copy -r local --item ID -o -

# Delete one item / everything in the namespace
copacli history -r local rm ID
copacli history -r local clear
```

### Aliases

`copacli down` = `copacli copy`, `copacli up` = `copacli paste`

### Using --server / --token directly (no config file)

```bash
copacli copy  --server http://host:8080 --token TOKEN
copacli paste --server http://host:8080 --token TOKEN "text"
copacli watch --server ws://host:8080/ws --token TOKEN
```

## API Reference

All endpoints require a matching token. The namespace is selected via the `X-Copa-Namespace` header (defaults to `"default"` when omitted).

### `GET /api/clipboard`

Returns the current content of the namespace as plain text.

```bash
curl -H "Authorization: Bearer TOKEN" \
     -H "X-Copa-Namespace: default" \
     http://localhost:8080/api/clipboard
```

Required token permission: read or rw.

### `POST /api/clipboard`

Stores new content and broadcasts it to all WebSocket subscribers of that namespace.

```bash
curl -H "Authorization: Bearer TOKEN" \
     -H "X-Copa-Namespace: default" \
     -X POST --data "content" \
     http://localhost:8080/api/clipboard

# From file
curl -H "Authorization: Bearer TOKEN" \
     -X POST --data-binary @file.txt \
     http://localhost:8080/api/clipboard
```

Returns `ok` (200), `unauthorized` (401), `namespace not found` (404), or `content too large` (413).

Required token permission: write or rw.

### History

Each namespace keeps its recent items, newest first. Timestamps are Unix milliseconds. These endpoints (and the file and capability endpoints below) accept the token **only** in the `Authorization` header.

```bash
# List items (read). Text items carry a preview of up to 200 characters, never the full content.
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/history
# [{"id":"…","kind":"text","created_at":…,"expires_at":…,"size":5,"preview":"hello"},
#  {"id":"…","kind":"file","created_at":…,"expires_at":…,"size":1048576,"name":"report.pdf","content_type":"application/pdf"}]

# Full content of one text item (read). 404 if unknown or expired, 409 if the item is a file.
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/history/ID

# Delete one item / all items of the namespace (write)
curl -H "Authorization: Bearer TOKEN" -X DELETE http://localhost:8080/api/history/ID
curl -H "Authorization: Bearer TOKEN" -X DELETE http://localhost:8080/api/history
```

`POST /api/clipboard` accepts an optional `X-Copa-TTL: <seconds>` header to make an item expire sooner than the namespace's `item_ttl_secs` (larger values are clamped).

`GET /api/clipboard` returns the newest unexpired *text* item — an empty body once it has expired.

### Files

Available when the server has `[server.storage]` configured; otherwise these return `404 {"error":"files not enabled"}`. Full description in [docs/FILES.md](docs/FILES.md).

```bash
# 1. Ask for an upload URL (write). 413 = over max_file_size, 507 = namespace quota full.
curl -H "Authorization: Bearer TOKEN" -X POST \
     -d '{"name":"report.pdf","size":1048576,"content_type":"application/pdf"}' \
     http://localhost:8080/api/files
# {"id":"…","upload_url":"https://s3…","method":"PUT","headers":{"Content-Length":"1048576",
#  "Content-Type":"application/octet-stream","Content-Disposition":"attachment; …"},"expires_at":…}

# 2. PUT the bytes to upload_url, sending exactly the returned headers.

# 3. Make the item visible (write). 409 if the object is missing or has the wrong size.
curl -H "Authorization: Bearer TOKEN" -X POST http://localhost:8080/api/files/ID/complete

# Ask for a download URL (read)
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/files/ID
# {"id":"…","download_url":"https://s3…","name":"report.pdf","size":1048576,"content_type":"application/pdf","expires_at":…}
```

### `GET /api/capabilities`

What the server supports for the namespace, for any valid token. A `404` means the server predates history and files.

```bash
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/capabilities
# {"history":true,"history_limit":20,"item_ttl_secs":86400,"size_limit":16384,
#  "files":true,"max_file_size":52428800,"file_quota_bytes":524288000,"presign_ttl_secs":300,
#  "read":true,"write":true}
```

### `GET /ws/events` — WebSocket item events

Authorized like `/ws` (header or `?token=`), read permission required. The server sends one JSON text frame per history change; frames sent by the client are ignored. `/ws` itself is unchanged and carries text content only — file items never appear there.

```json
{"type":"item_added","item":{"id":"…","kind":"file","name":"report.pdf","size":1048576,"created_at":0,"expires_at":0,"content_type":"application/pdf"}}
{"type":"item_removed","id":"…","reason":"expired"}
```

`reason` is `expired`, `deleted` or `evicted`. An `item_added` for an id you already have means the item was refreshed (same text pushed again).

```bash
websocat -n -U "ws://localhost:8080/ws/events?token=TOKEN&namespace=default"
```

### `GET /ws` — WebSocket

Subscribe to real-time updates for a namespace.

**Auth and namespace** can be passed as headers during the HTTP upgrade:

```
Authorization: Bearer TOKEN
X-Copa-Namespace: default
```

Or as query parameters (for clients that cannot set headers during upgrade):

```
ws://host:8080/ws?token=TOKEN&namespace=default
```

**Protocol:** plain UTF-8 text frames.

- On connect: server sends the current namespace content immediately.
- On any POST to the namespace: server broadcasts the new content to all connected subscribers.
- Clients with write permission can also send frames to update the namespace (other subscribers receive the update).

```bash
# Requires websocat
websocat "ws://localhost:8080/ws?token=TOKEN&namespace=default"
```

## Web UI

Open `http://host:8080/` in a browser.

- **Namespace selector** — switch between namespaces; each uses its own token
- **History** — recent items with size and time until expiry; click a text item to load it, download files, delete items. Updates live while **Live** is on
- **Files** — drop files on the clipboard panel, paste them (e.g. a screenshot), or use **Upload file**; shown only when the server has file sharing enabled

History and files need the Vite web app (`--static-dir web/dist` or the hosted copy); the fallback UI embedded in `copasrv` is text-only.
- **Pull / Push** — one-shot fetch or store
- **Live** checkbox — opens a WebSocket subscription; textarea updates instantly on every server-side change
- **Direct sync** — copy/paste via browser Clipboard API
- **Auto-pull** — polling fallback (2 / 5 / 10 / 30 s intervals)
- **Servers panel** — manage multiple `copasrv` instances stored in IndexedDB
- **Shareable link** — `#token=…&url=…` fragment that never reaches server logs

## tmux Integration

### Persistent auto-sync (recommended)

Run `copacli watch` in a background tmux window. Every time content is pushed to the server by any client, it lands in your local tmux buffer automatically.

```bash
# In a dedicated tmux window
copacli watch -r local
```

You can also start it as a background process:
```bash
copacli watch -r local &>/tmp/copacli-watch.log &
```

### One-shot tmux keybindings

Add to `~/.tmux.conf`:

```tmux
# Upload tmux buffer → copa (Prefix + Shift+C)
bind C run-shell "tmux save-buffer - | copacli paste -r local -i - && tmux display-message '✓ Uploaded'"

# Download copa → tmux buffer + paste (Prefix + Shift+V)
bind V run-shell "copacli copy -r local -o - | tmux load-buffer - && tmux paste-buffer && tmux display-message '✓ Downloaded'"

# Auto-sync on vi-mode copy
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tmux load-buffer - && (copacli paste -r local -i - 2>/dev/null &)"
```

Reload: `tmux source-file ~/.tmux.conf`

### System clipboard + copa

**macOS:**
```tmux
# Copy → tmux buffer + copa + macOS clipboard
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tee >(tmux load-buffer -) >(copacli paste -r local -i - 2>/dev/null &) | pbcopy"
```

**Linux X11:**
```tmux
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tee >(tmux load-buffer -) >(copacli paste -r local -i - 2>/dev/null &) | xsel -ib"
```

## Security

- Tokens live in URL fragments (`#token=…`) — never in server logs
- Separate read / write tokens let you share read access without granting write access
- Default bind address is `127.0.0.1`; use `--bind 0.0.0.0` only when needed
- Use HTTPS (e.g. behind Caddy, HAProxy or a Cloudflare Tunnel — examples in [deploy/garage/proxy](deploy/garage/proxy)) in production
- Per-namespace size limits, history limits and file quotas bound memory and storage use
- Everything expires: text and files are removed after `item_ttl_secs`, files from the object store too
- File sharing uses short-lived presigned URLs; S3 credentials never leave the server. Read the [security checklist](docs/FILES.md#security-checklist) before exposing it to the internet
- `allowed_origins` restricts which web origins may call the API
- Rotate tokens with `copasrv --generate-token`

## Development

```bash
# Build debug
cargo build

# Build release
cargo build --release

# Run server in dev
cargo run --bin copasrv

# Run client in dev
cargo run --bin copacli -- paste -r local "test"

# Check
cargo check

# Tests
cargo test

# End-to-end file sharing test against a local Garage (needs Docker)
make test-s3
```

### Try file sharing by hand on your local network

```bash
# Garage + copasrv on 0.0.0.0, plain http; prints the web link, token and copacli commands
make verify-s3

# Use a host name other devices can resolve instead of the detected LAN address
make verify-s3 HOST=mybox.lan

# HTTPS: certificate (full chain) and key valid for HOST; copasrv and Garage stay on loopback
make verify-s3 HOST=mybox.lan CERT=/path/fullchain.pem KEY=/path/privkey.pem
```

Optional `PORT=`, `S3_PORT=` and `TOKEN=`. Ctrl-C stops it, deletes that run's files and puts Garage back on loopback. Without a certificate everything, including the token, travels unencrypted — trusted networks only.

## Troubleshooting

**"no remote specified and no default_remote in config"**

Add to `~/.config/copa/config.toml`:
```toml
[cli]
default_remote = "local"

[cli.remotes.local]
url   = "http://127.0.0.1:8080"
token = "your-token"
```

**401 Unauthorized**

The token in the request does not match any token for the target namespace. Check that the token matches `rw_token`, `read_token`, or `write_token` in the server config.

**404 Namespace not found**

The `X-Copa-Namespace` header names a namespace that does not exist on the server.

**413 Content Too Large**

The body exceeds the namespace `size_limit`. Increase it in the server config or use a different namespace.

**The clipboard is empty although something was pushed yesterday**

Items expire after `item_ttl_secs` (default 24 hours). Raise it for the namespace if you want content to live longer.

**File upload or download problems**

See [docs/FILES.md — Troubleshooting](docs/FILES.md#troubleshooting).

**"no buffers" from tmux**

Nothing has been copied in tmux yet. Enter copy mode (`Prefix + [`), select text, press Enter.

**copacli watch keeps reconnecting**

The server is unreachable or the token is wrong. Check `copasrv` is running and the token matches.

## License

MIT
