# copa

**Clipboard over HTTP** — a minimal, token-authenticated clipboard server with named namespaces, WebSocket push notifications, and a modular client.

## Architecture

| Binary | Role |
|--------|------|
| **`copasrv`** | HTTP/WebSocket server. Manages named clipboard namespaces in memory. No tmux dependency. |
| **`copacli`** | Local client. One-shot copy/paste and persistent `watch` mode. Handles all tmux, file, and platform-clipboard I/O. |
| **`copa-tray`** | Windows system-tray client (separate build). |

The separation keeps the server's attack surface small — it stores bytes and pushes WebSocket events; it never touches tmux or runs subprocesses.

## Features

- Named clipboard **namespaces** — independent buffers, each with its own size limit (default 16 KB) and separate read / write / read-write tokens
- **WebSocket push** — clients receive updates instantly without polling (`/ws`)
- **REST API** — simple GET/POST on `/api/clipboard` with `X-Copa-Namespace` header
- **`copacli watch`** — persistent background bridge: WebSocket → tmux buffer (or any command), auto-reconnects
- **`copacli copy/paste`** — one-shot download/upload with full I/O routing (tmux, file, stdout, platform clipboard tools)
- **Web UI** — namespace selector, Live WebSocket toggle, auto-pull, shareable token links

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

# Named namespaces — each is an independent clipboard buffer.
# size_limit is in bytes (default: 16384 = 16 KB).
# Provide any combination of read_token, write_token, rw_token.
[server.namespaces.default]
size_limit = 16384
rw_token   = "your-rw-token"

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
- Use HTTPS (e.g. behind nginx) in production
- Per-namespace size limits prevent memory exhaustion (default 16 KB)
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
```

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

**"no buffers" from tmux**

Nothing has been copied in tmux yet. Enter copy mode (`Prefix + [`), select text, press Enter.

**copacli watch keeps reconnecting**

The server is unreachable or the token is wrong. Check `copasrv` is running and the token matches.

## License

MIT
