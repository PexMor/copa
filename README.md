# copa

**Clipboard over HTTP** — expose tmux paste buffer and a server-side clipboard as an authenticated HTTP API and web UI.

## Features

- 🔐 Token-based authentication
- 📋 Dual clipboard: tmux buffer + server-side storage
- 🌐 Web UI with light/dark/auto themes
- 🔄 Bi-directional sync with remote servers
- 🖥️ System clipboard integration (macOS, X11, Wayland)
- 📁 File I/O support
- 🔌 Multi-remote configuration

## Installation

```bash
# Build and install to ~/bin
make install

# Or use cargo
cargo install --path .

# Generate auth token
copa --generate-token
```

## Quick Start

### 1. Start the server

```bash
# Start with auto-generated token
copa serve

# Or with persistent token from config
mkdir -p ~/.config/copa
cat > ~/.config/copa/config.toml <<EOF
[server]
token = "$(copa --generate-token)"

[cli]
default_remote = "local"

[cli.remotes.local]
url = "http://127.0.0.1:8080"
token = "YOUR_TOKEN_HERE"
EOF

copa serve
```

### 2. Access the web UI

Open `http://127.0.0.1:8080/#token=YOUR_TOKEN` in your browser.

### 3. Use the CLI

```bash
# Upload tmux buffer to remote
copa cli paste

# Download from remote to tmux buffer
copa cli copy

# Short aliases
copa cli up    # upload
copa cli down  # download
```

## Configuration

Configuration file: `~/.config/copa/config.toml`

```toml
[server]
port = 8080
bind = "127.0.0.1"
token = "your-server-token"
# socket = "/tmp/tmux-1000/default"  # auto-detected
# session = "main"

[cli]
default_remote = "local"

[cli.remotes.local]
url = "http://127.0.0.1:8080"
token = "your-server-token"

[cli.remotes.work]
url = "https://copa.example.com"
token = "work-token"
headers = { "X-Custom-Header" = "value" }
```

### Environment Variables

All config options can be overridden via environment:

```bash
export COPA_PORT=9000
export COPA_BIND=0.0.0.0
export COPA_TOKEN=my-token
export COPA_SOCKET=/tmp/tmux-1000/default
export COPA_SESSION=main
export COPA_REMOTE=work
```

### Precedence

CLI args > Environment variables > Config file > Defaults

## Usage

### Server

```bash
# Start server (defaults from config)
copa serve

# Override settings
copa serve --port 9000 --bind 0.0.0.0 --token secret123

# Bind to all interfaces (remote access)
copa serve --bind 0.0.0.0
```

### CLI Client

#### Basic Operations

```bash
# Download from remote → tmux buffer
copa cli copy
copa cli down

# Upload tmux buffer → remote
copa cli paste
copa cli up

# Use specific remote
copa cli copy -r work
copa cli paste -r home
```

#### File I/O

```bash
# Download to file
copa cli copy -o data.txt
copa cli copy -o -  # stdout

# Upload from file
copa cli paste -i data.txt
copa cli paste -i -  # stdin
echo "data" | copa cli paste
```

#### System Clipboard Integration

**macOS:**
```bash
# Download to macOS clipboard
copa cli copy --output-cmd pbcopy

# Upload from macOS clipboard
copa cli paste --input-cmd pbpaste
```

**Linux X11:**
```bash
# Download to X11 clipboard
copa cli copy --output-cmd 'xsel -ib'
copa cli copy --output-cmd 'xclip -selection clipboard'

# Upload from X11 clipboard
copa cli paste --input-cmd 'xsel -ob'
copa cli paste --input-cmd 'xclip -selection clipboard -o'
```

**Linux Wayland:**
```bash
# Download to Wayland clipboard
copa cli copy --output-cmd wl-copy

# Upload from Wayland clipboard
copa cli paste --input-cmd wl-paste
```

#### Direct Text

```bash
# Upload literal text
copa cli paste "hello world"
copa cli up "quick message"
```

### curl Examples

```bash
# Download clipboard
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/clipboard

# Upload clipboard
curl -H "Authorization: Bearer TOKEN" \
     http://localhost:8080/api/clipboard \
     -X POST --data "clipboard content"

# Upload from file
curl -H "Authorization: Bearer TOKEN" \
     http://localhost:8080/api/clipboard \
     -X POST --data-binary @file.txt
```

## tmux Integration

### Basic tmux Copy/Paste

By default, tmux uses these keybindings:

- **Enter copy mode:** `Prefix + [`
- **Start selection:** `Space` (in copy mode)
- **Copy selection:** `Enter`
- **Paste buffer:** `Prefix + ]`

### Copy tmux Buffer to Remote

Add to `~/.tmux.conf`:

```tmux
# Upload tmux buffer to copa remote on Prefix+C
bind C run-shell "tmux save-buffer - | copa cli paste -i -"

# Alternative: use display-message to show result
bind C run-shell "tmux save-buffer - | copa cli paste -i - && tmux display-message 'Uploaded to copa'"
```

### Paste from Remote to tmux Buffer

```tmux
# Download from copa remote to tmux buffer on Prefix+V
bind V run-shell "copa cli copy -o - | tmux load-buffer - && tmux paste-buffer"

# Or just load to buffer without pasting
bind V run-shell "copa cli copy -o - | tmux load-buffer -"
```

### Combined Copy/Paste Workflow

```tmux
# Copy selection and upload to remote
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "tmux load-buffer - && copa cli paste -i -"

# Download from remote and paste
bind P run-shell "copa cli copy -o - | tmux load-buffer - && tmux paste-buffer"
```

### Advanced: Sync on Copy

Auto-upload every time you copy in tmux:

```tmux
# Sync clipboard on every copy (vi mode)
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tmux load-buffer - && copa cli paste -i - 2>/dev/null &"

# Sync clipboard on every copy (emacs mode)
bind-key -T copy-mode M-w send-keys -X copy-pipe-and-cancel \
  "tmux load-buffer - && copa cli paste -i - 2>/dev/null &"
```

### System Clipboard + copa

Bridge tmux, copa, and system clipboard:

**macOS:**
```tmux
# Copy to all: tmux buffer, copa remote, and macOS clipboard
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tee >(tmux load-buffer -) >(copa cli paste -i - 2>/dev/null &) | pbcopy"

# Paste from system clipboard via copa
bind P run-shell "pbpaste | copa cli paste -i - && copa cli copy -o - | tmux load-buffer - && tmux paste-buffer"
```

**Linux X11:**
```tmux
# Copy to all: tmux buffer, copa remote, and X11 clipboard
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tee >(tmux load-buffer -) >(copa cli paste -i - 2>/dev/null &) | xsel -ib"

# Paste from X11 clipboard via copa
bind P run-shell "xsel -ob | copa cli paste -i - && copa cli copy -o - | tmux load-buffer - && tmux paste-buffer"
```

### Recommended Setup

Add to `~/.tmux.conf` for the best experience:

```tmux
# Upload tmux buffer to copa (Prefix + Shift+C)
bind C run-shell "tmux save-buffer - | copa cli paste -i - && tmux display-message '✓ Uploaded to copa'"

# Download from copa to tmux buffer and paste (Prefix + Shift+V)
bind V run-shell "copa cli copy -o - | tmux load-buffer - && tmux paste-buffer && tmux display-message '✓ Downloaded from copa'"

# Auto-sync on copy (vi copy mode)
bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel \
  "tmux load-buffer - && (copa cli paste -i - 2>/dev/null &)"
```

Reload config: `tmux source-file ~/.tmux.conf`

## API Endpoints

### `/api/clipboard`

**GET** — Retrieve clipboard content (plain text)
```bash
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/clipboard
```

**POST** — Store clipboard content (plain text)
```bash
curl -H "Authorization: Bearer TOKEN" \
     -X POST --data "content" \
     http://localhost:8080/api/clipboard
```

### `/api/buffer`

**GET** — Retrieve tmux buffer (JSON)
```bash
curl -H "Authorization: Bearer TOKEN" http://localhost:8080/api/buffer
# Response: {"content":"buffer text"}
```

**POST** — Set tmux buffer (plain text body)
```bash
curl -H "Authorization: Bearer TOKEN" \
     -X POST --data "buffer content" \
     http://localhost:8080/api/buffer
```

## Web UI

The web UI provides:

- **Paste Buffer** — View/edit tmux buffer with push/pull/copy/clear actions
- **Server Clipboard** — View/edit server clipboard with push/pull/copy/clear actions
- **Auto-pull** — Configurable auto-refresh (2/5/10/30 seconds)
- **Shareable Link** — Token-embedded URL for easy sharing
- **Theme Switcher** — Light/Dark/Auto modes

## Security

- Tokens are stored in URL fragments (`#token=...`) — never sent to server logs
- Use HTTPS in production
- Bind to `127.0.0.1` for local-only access
- Use `--bind 0.0.0.0` only when needed and combine with firewall rules
- Rotate tokens regularly using `copa --generate-token`

## Development

```bash
# Build debug
cargo build

# Build release
cargo build --release

# Run server in dev
cargo run -- serve --port 8080

# Run CLI in dev
cargo run -- cli paste "test"

# Check code
cargo check

# Run tests
cargo test
```

## Troubleshooting

**"no remote specified and no default_remote in config"**

Ensure `[cli]` section exists with `default_remote` and remotes:

```toml
[cli]
default_remote = "local"

[cli.remotes.local]
url = "http://127.0.0.1:8080"
token = "your-token"
```

**"no buffers" from tmux**

Your tmux session has no buffer. Copy something in tmux first (`Prefix + [`, select, `Enter`).

**Token auth fails**

Check token matches between server and remote config. Use `copa --generate-token` for a fresh token.

**tmux socket not found**

Specify explicitly:
```bash
copa serve --socket /tmp/tmux-1000/default
copa cli paste --socket /tmp/tmux-1000/default
```

## License

MIT

## Author

Created for seamless clipboard sync across tmux sessions, remote machines, and system clipboards.
