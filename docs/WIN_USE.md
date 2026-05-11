# copa-tray — Windows usage guide

`copa-tray.exe` is a Windows system-tray client for a `copasrv` instance.
Right-click the tray icon to push your Windows clipboard to the server ("Copy to server")
or pull the server clipboard back ("Paste from server").

It operates on the `default` namespace using a single rw token — the same token
you configure in `[server.namespaces.default]` on the server side.

---

## 1. Get the binary

Build from a Linux cross-compile environment:

```bash
make tray-windows
# → target/x86_64-pc-windows-gnu/release/copa-tray.exe
```

Or build natively on Windows:

```powershell
cargo build --release --bin copa-tray
# binary: target\release\copa-tray.exe
```

Copy `copa-tray.exe` anywhere on your `PATH`, e.g. `C:\Users\<you>\bin\`.

---

## 2. Config file

**Location:** `%APPDATA%\copa\config.toml`

That expands to something like:

```
C:\Users\<you>\AppData\Roaming\copa\config.toml
```

Create the directory and file:

```powershell
mkdir "$env:APPDATA\copa"
notepad "$env:APPDATA\copa\config.toml"
```

### Minimal config

```toml
[cli.remotes.home]
url   = "https://copa.example.com"
token = "your-token-here"
```

If you have only one remote it is selected automatically.
To make a specific remote the default when you have several:

```toml
[cli]
default_remote = "home"

[cli.remotes.home]
url   = "https://copa.example.com"
token = "your-token-here"

[cli.remotes.work]
url   = "https://copa-work.example.com"
token = "work-token"
```

### CRLF vs LF

**Either line ending works.** The TOML parser (`toml` crate) accepts both `LF`
and `CRLF`. Use whatever your editor saves by default — Notepad and most Windows
editors write `CRLF`, VS Code defaults to `LF`; both are fine.

---

## 3. Run

Double-click `copa-tray.exe` or launch it from a terminal.
A small icon appears in the system tray (bottom-right corner, you may need to
expand the hidden-icons overflow).

### Override settings without editing the config file

| Flag / env var            | Effect                          |
|---------------------------|---------------------------------|
| `--url <URL>`             | Server base URL                 |
| `--token <TOKEN>`         | Bearer auth token               |
| `--remote <NAME>`         | Named remote from config file   |
| `--config <PATH>`         | Custom config file path         |
| `--header KEY=VAL`        | Extra HTTP header (repeatable)  |
| `COPA_URL`, `COPA_TOKEN`, `COPA_REMOTE`, `COPA_CONFIG` | Same as flags, via env |

Example shortcut target (no config file needed):

```
copa-tray.exe --url https://copa.example.com --token abc123
```

---

## 4. Auto-start with Windows

1. Press **Win + R**, type `shell:startup`, press Enter.
2. Place a shortcut to `copa-tray.exe` (with any desired flags) in that folder.

---

## 5. MQTT clipboard sharing

In addition to HTTP/WebSocket sync with `copasrv`, copa-tray can exchange
clipboard content directly with any MQTT broker — useful when you want end-to-end
encryption or when a copasrv instance is not available.

### How it works

The tray menu exposes two one-shot operations:

| Menu item | Action |
|-----------|--------|
| **Upload to MQTT** | Reads the current Windows clipboard → encrypts (AES-256-GCM, if a key is configured) → publishes to the broker with `retain=true` and QoS 1 → waits for ACK → disconnects. The tray tooltip shows how many bytes were published. |
| **Download from MQTT** | Connects to the broker → subscribes to the configured topic → receives the **retained** message (the last value ever published to that topic) → decrypts → writes to the Windows clipboard → disconnects. The tray tooltip shows how many bytes were received. |

There is **no background listener** and **no internal buffer** — copa-tray only
connects when you click a menu item. Encryption/decryption uses the same
AES-256-GCM envelope format as the web app, so keys and messages are fully
interoperable between copa-tray, `copacli`, and the browser UI.

The broker retains the last published message indefinitely (standard MQTT
`retain` flag), so "Download from MQTT" always retrieves the most recently
uploaded content without requiring both devices to be online at the same time.

### Config

Add an MQTT server block to `%APPDATA%\copa\config.toml`:

```toml
[cli]
default_mqtt_server = "mybroker"

[cli.mqtt_servers.mybroker]
broker_url       = "wss://broker.emqx.io:8084/mqtt"
topic            = "copa/clipboard/mydevice"
aes_key          = "V2hhdCBhcmUgeW91IGxvb2tpbmcgYXQ/ICAgIDMyYg=="
# max_message_size = 65535  # optional, default 65535
# client_id        = "my-pc" # optional, random if omitted
```

`broker_url` scheme support:

| Scheme | Transport | Default port |
|--------|-----------|--------------|
| `mqtt://` | TCP plain | 1883 |
| `mqtts://` | TCP + TLS (system roots) | 8883 |
| `ws://` | WebSocket | 8083 |
| `wss://` | WebSocket + TLS (system roots) | 8084 |

`aes_key` is optional. If omitted, messages are sent and received as plain text
with a warning in the tooltip. Accepted key formats (all must be exactly 32 bytes
after decoding):

- **64-char hex** — `deadbeef…` (64 hex digits)
- **Base58** (Bitcoin alphabet) — e.g. output of `copacli gen-key --base58`
- **Base64** — standard base64, with or without padding

### Override settings without editing the config file

| Flag / env var | Effect |
|----------------|--------|
| `--mqtt-server <NAME>` | Named entry from `[cli.mqtt_servers]` |
| `--mqtt-broker <URL>` / `COPA_MQTT_BROKER` | Broker URL (overrides config) |
| `--mqtt-topic <TOPIC>` / `COPA_MQTT_TOPIC` | Topic (overrides config) |
| `--mqtt-key <KEY>` / `COPA_MQTT_KEY` | AES-256 key (overrides config) |

Example shortcut that enables MQTT without a config file:

```
copa-tray.exe --url https://copa.example.com --token abc123 ^
  --mqtt-broker wss://broker.emqx.io:8084/mqtt ^
  --mqtt-topic copa/clipboard/mypc ^
  --mqtt-key "V2hhdCBhcmUgeW91IGxvb2tpbmcgYXQ/ICAgIDMyYg=="
```

---

## 6. Troubleshooting

### Startup error dialog

If `copa-tray` cannot start (missing config, bad token, etc.) it shows a
`copa-tray — startup error` message box explaining what went wrong.

The same message is written to:

```
%TEMP%\copa-tray-error.txt
```

Open it in Notepad for the full error text:

```powershell
notepad $env:TEMP\copa-tray-error.txt
```

### Common errors

| Message | Fix |
|---------|-----|
| `No server configured` | Create `%APPDATA%\copa\config.toml` with a `[cli.remotes.*]` entry, or pass `--url` + `--token` flags. |
| `Remote 'x' not found in config file` | Check the remote name matches what is in the config file. |
| `Remote 'x' has no url` / `no token` | Fill in the missing field in the config file. |
| HTTP 401 | The token does not match any token for the `default` namespace on the server. |
| HTTP 404 | The `default` namespace does not exist on the server — check server config. |
| Connection refused / timeout | `copasrv` is not running or the URL is wrong. |

### Tray icon not visible

Expand the system-tray overflow (the `^` arrow next to the clock) — Windows
hides new tray icons there by default. You can drag the icon to the main taskbar
to pin it.
