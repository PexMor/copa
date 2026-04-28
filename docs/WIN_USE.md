# copa-tray — Windows usage guide

`copa-tray.exe` is a Windows system-tray client for the copa clipboard server.
Right-click the tray icon to push your Windows clipboard to the server ("Copy to server")
or pull the server clipboard back ("Paste from server").

---

## 1. Get the binary

Build from source on a Windows machine (or in a cross-compile environment):

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

## 5. Troubleshooting

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
| HTTP 401 / 403 | The token does not match the server's token. |
| Connection refused / timeout | The server is not reachable at the configured URL. |

### Tray icon not visible

Expand the system-tray overflow (the `^` arrow next to the clock) — Windows
hides new tray icons there by default. You can drag the icon to the main taskbar
to pin it.
