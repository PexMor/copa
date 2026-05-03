/// copacli — local client for copasrv
///
/// Subcommands:
///   copy   one-shot: GET clipboard → output (tmux/file/cmd/stdout)
///   paste  one-shot: input (tmux/file/cmd/stdin) → POST clipboard
///   watch  persistent: WebSocket → output (tmux/file/cmd/stdout), auto-reconnects
///   down   alias for copy
///   up     alias for paste
use clap::{Parser, Subcommand};
use copa::{config_path, load_config_file};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{collections::HashMap, io::Read, io::IsTerminal, path::PathBuf};
use tokio_tungstenite::{connect_async, tungstenite::Message};

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Debug, Clone)]
struct Remote {
    url:   String,
    token: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Deserialize, Default, Debug)]
struct CliConfig {
    #[serde(default)]
    remotes: HashMap<String, Remote>,
    default_remote: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct ConfigFile {
    #[serde(default)]
    cli: CliConfig,
}

fn load_config(path: Option<PathBuf>) -> ConfigFile {
    load_config_file::<ConfigFile>(&path.unwrap_or_else(config_path))
}

fn get_remote(cfg: &ConfigFile, name: Option<String>) -> Result<Remote, String> {
    let name = name
        .or_else(|| cfg.cli.default_remote.clone())
        .ok_or_else(|| format!(
            "no remote specified and no default_remote in [cli] section\n\
             config has {} remotes: {:?}",
            cfg.cli.remotes.len(),
            cfg.cli.remotes.keys().collect::<Vec<_>>()
        ))?;
    cfg.cli.remotes.get(&name).cloned()
        .ok_or_else(|| format!("remote '{name}' not found in [cli.remotes]"))
}

// ── tmux helpers ──────────────────────────────────────────────────────────────

fn resolve_socket(cli_val: Option<String>) -> String {
    if let Some(s) = cli_val { return s; }
    if let Ok(tmux) = std::env::var("TMUX") {
        if let Some(p) = tmux.split(',').next() { return p.to_string(); }
    }
    format!("/tmp/tmux-{}/default", unsafe { libc::getuid() })
}

fn tmux_get_buffer(socket: &str, session: &Option<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("tmux");
    cmd.arg("-S").arg(socket);
    if let Some(s) = session { cmd.arg("-t").arg(s); }
    cmd.arg("show-buffer");
    let out = cmd.output().map_err(|e| format!("exec tmux: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        if err.contains("no buffers") || err.contains("no current buffer") {
            Ok(String::new())
        } else {
            Err(err)
        }
    }
}

fn tmux_set_buffer(socket: &str, session: &Option<String>, data: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("tmux");
    cmd.arg("-S").arg(socket);
    if let Some(s) = session { cmd.arg("-t").arg(s); }
    cmd.args(["set-buffer", "--", data]);
    let out = cmd.output().map_err(|e| format!("exec tmux: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// ── Output routing ────────────────────────────────────────────────────────────

fn route_output(
    text: &str,
    output_cmd: &Option<String>,
    output: &Option<String>,
    socket: &str,
    session: &Option<String>,
) -> Result<(), String> {
    if let Some(cmd) = output_cmd {
        eprintln!("→ piping to command: {cmd}");
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() { return Err("empty command".into()); }
        let mut child = std::process::Command::new(parts[0])
            .args(&parts[1..])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {cmd}: {e}"))?;
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(text.as_bytes())
            .map_err(|e| format!("write to {cmd}: {e}"))?;
        let status = child.wait().map_err(|e| format!("wait {cmd}: {e}"))?;
        if !status.success() { return Err(format!("command '{cmd}' failed with {status}")); }
        eprintln!("✓ piped {} bytes to command", text.len());
    } else {
        match output.as_deref() {
            Some("-") => {
                print!("{text}");
                eprintln!("✓ wrote {} bytes to stdout", text.len());
            }
            Some(path) => {
                std::fs::write(path, text).map_err(|e| format!("write to {path}: {e}"))?;
                eprintln!("✓ wrote {} bytes to {path}", text.len());
            }
            None => {
                eprintln!("→ writing to tmux buffer (socket: {socket})");
                tmux_set_buffer(socket, session, text)?;
                eprintln!("✓ set {} bytes in tmux buffer", text.len());
            }
        }
    }
    Ok(())
}

// ── Input routing ─────────────────────────────────────────────────────────────

fn route_input(
    text_arg: &Option<String>,
    input_cmd: &Option<String>,
    input: &Option<String>,
    socket: &str,
    session: &Option<String>,
) -> Result<String, String> {
    if let Some(t) = text_arg {
        eprintln!("→ using text from CLI argument ({} bytes)", t.len());
        return Ok(t.clone());
    }
    if let Some(cmd) = input_cmd {
        eprintln!("→ running command: {cmd}");
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() { return Err("empty command".into()); }
        let out = std::process::Command::new(parts[0])
            .args(&parts[1..])
            .output()
            .map_err(|e| format!("run {cmd}: {e}"))?;
        if !out.status.success() {
            return Err(format!("command '{cmd}' failed with {}", out.status));
        }
        let buf = String::from_utf8_lossy(&out.stdout).into_owned();
        eprintln!("← read {} bytes from command", buf.len());
        return Ok(buf);
    }
    if let Some(path) = input {
        if path == "-" {
            eprintln!("→ reading from stdin");
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("stdin: {e}"))?;
            eprintln!("← read {} bytes from stdin", buf.len());
            return Ok(buf);
        } else {
            eprintln!("→ reading from file: {path}");
            let buf = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
            eprintln!("← read {} bytes from {path}", buf.len());
            return Ok(buf);
        }
    }
    if !std::io::stdin().is_terminal() {
        eprintln!("→ reading from stdin");
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("stdin: {e}"))?;
        eprintln!("← read {} bytes from stdin", buf.len());
        return Ok(buf);
    }
    eprintln!("→ reading from tmux buffer (socket: {socket})");
    let buf = tmux_get_buffer(socket, session)?;
    eprintln!("← read {} bytes from tmux", buf.len());
    Ok(buf)
}

// ── copy / paste operations ───────────────────────────────────────────────────

fn do_copy(
    remote: Remote,
    socket: String,
    session: Option<String>,
    namespace: Option<String>,
    output: Option<String>,
    output_cmd: Option<String>,
    verbose: bool,
) -> Result<(), String> {
    eprintln!("→ downloading from {}/api/clipboard", remote.url);
    let mut req = ureq::get(&format!("{}/api/clipboard", remote.url))
        .set("Authorization", &format!("Bearer {}", remote.token));
    if let Some(ns) = &namespace { req = req.set("X-Copa-Namespace", ns); }
    for (k, v) in &remote.headers {
        if verbose { eprintln!("  header: {k}: {v}"); } else { eprintln!("  header: {k}"); }
        req = req.set(k, v);
    }
    let text = req.call().map_err(|e| format!("request failed: {e}"))?
        .into_string().map_err(|e| format!("read failed: {e}"))?;
    eprintln!("← received {} bytes", text.len());
    route_output(&text, &output_cmd, &output, &socket, &session)
}

fn do_paste(
    remote: Remote,
    socket: String,
    session: Option<String>,
    namespace: Option<String>,
    input: Option<String>,
    input_cmd: Option<String>,
    text: Option<String>,
    verbose: bool,
) -> Result<(), String> {
    let data = route_input(&text, &input_cmd, &input, &socket, &session)?;
    eprintln!("→ uploading to {}/api/clipboard", remote.url);
    let mut req = ureq::post(&format!("{}/api/clipboard", remote.url))
        .set("Authorization", &format!("Bearer {}", remote.token));
    if let Some(ns) = &namespace { req = req.set("X-Copa-Namespace", ns); }
    for (k, v) in &remote.headers {
        if verbose { eprintln!("  header: {k}: {v}"); } else { eprintln!("  header: {k}"); }
        req = req.set(k, v);
    }
    req.send_string(&data).map_err(|e| format!("request failed: {e}"))?;
    eprintln!("✓ pasted {} bytes to remote", data.len());
    Ok(())
}

// ── watch (persistent WebSocket) ──────────────────────────────────────────────

async fn do_watch(
    server: String,
    token: String,
    namespace: String,
    socket: String,
    session: Option<String>,
    output: Option<String>,
    output_cmd: Option<String>,
    max_backoff: u64,
) {
    let mut backoff = 1u64;
    loop {
        eprintln!("copacli watch: connecting to {server}");
        match watch_once(&server, &token, &namespace, &socket, &session, &output, &output_cmd).await {
            Ok(()) => {
                eprintln!("copacli watch: connection closed");
                backoff = 1;
            }
            Err(e) => {
                eprintln!("copacli watch: error: {e}");
            }
        }
        eprintln!("copacli watch: reconnecting in {backoff}s");
        tokio::time::sleep(tokio::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

async fn watch_once(
    server: &str,
    token: &str,
    namespace: &str,
    socket: &str,
    session: &Option<String>,
    output: &Option<String>,
    output_cmd: &Option<String>,
) -> anyhow::Result<()> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    // Convert http:// to ws:// if needed
    let ws_url = server
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    // Append /ws if not already a ws path
    let ws_url = if ws_url.contains("/ws") { ws_url } else { format!("{ws_url}/ws") };

    let url = format!("{ws_url}?token={}&namespace={}",
        urlencoding_simple(token), urlencoding_simple(namespace));

    let mut req = url.as_str().into_client_request()?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {token}").parse()?,
    );

    let (ws_stream, _) = connect_async(req).await?;
    eprintln!("copacli watch: connected (namespace={namespace})");

    let (_, mut read) = ws_stream.split();

    // Skip the first message (current content on connect) — or process it too
    while let Some(msg) = read.next().await {
        let msg = msg?;
        let text = match msg {
            Message::Text(t)   => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_)  => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        eprintln!("copacli watch: received {} bytes", text.len());
        if let Err(e) = route_output(&text, output_cmd, output, socket, session) {
            eprintln!("copacli watch: output error: {e}");
        }
    }
    Ok(())
}

fn urlencoding_simple(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}

// ── CLI definition ────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(
    name = "copacli",
    about = "copa client — copy/paste/watch against a copasrv instance",
    long_about = "Examples:\n  \
      copacli copy -r local                          Download → tmux buffer\n  \
      copacli copy -r local --output-cmd pbcopy      Download → macOS clipboard\n  \
      copacli copy -r local --output-cmd 'xsel -ib'  Download → X11 clipboard\n  \
      copacli copy -r local -o -                     Download → stdout\n  \
      copacli paste -r local                         Upload tmux buffer → remote\n  \
      copacli paste -r local --input-cmd pbpaste     Upload macOS clipboard → remote\n  \
      copacli paste -r local 'text'                  Upload literal text → remote\n  \
      echo data | copacli paste -r local             Upload stdin → remote\n  \
      copacli watch -r local                         Live WebSocket → tmux buffer"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
    #[arg(short, long, env = "COPA_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long)]
    print_config_path: bool,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Download from server → output (default: tmux buffer)
    Copy {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
        #[arg(long, env = "COPA_SERVER", help = "Server URL (overrides remote config)")]
        server: Option<String>,
        #[arg(long, env = "COPA_TOKEN", help = "Auth token (overrides remote config)")]
        token: Option<String>,
        #[arg(long, env = "COPA_NAMESPACE")]
        namespace: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Output to file or stdout ('-')")]
        output: Option<String>,
        #[arg(long, value_name = "CMD", help = "Pipe output to command (e.g. 'pbcopy', 'xsel -ib', 'wl-copy')")]
        output_cmd: Option<String>,
        #[arg(short, long)]
        verbose: bool,
    },
    /// Upload input → server (default input: tmux buffer)
    Paste {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
        #[arg(long, env = "COPA_SERVER")]
        server: Option<String>,
        #[arg(long, env = "COPA_TOKEN")]
        token: Option<String>,
        #[arg(long, env = "COPA_NAMESPACE")]
        namespace: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Input from file or stdin ('-')")]
        input: Option<String>,
        #[arg(long, value_name = "CMD", help = "Read input from command (e.g. 'pbpaste', 'xsel -ob', 'wl-paste')")]
        input_cmd: Option<String>,
        #[arg(value_name = "TEXT")]
        text: Option<String>,
        #[arg(short, long)]
        verbose: bool,
    },
    /// Persistent WebSocket subscriber → output (default: tmux buffer)
    Watch {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
        #[arg(long, env = "COPA_SERVER")]
        server: Option<String>,
        #[arg(long, env = "COPA_TOKEN")]
        token: Option<String>,
        #[arg(long, env = "COPA_NAMESPACE", default_value = "default")]
        namespace: String,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Output to file or stdout ('-')")]
        output: Option<String>,
        #[arg(long, value_name = "CMD", help = "Pipe each received update to command")]
        output_cmd: Option<String>,
        #[arg(long, default_value_t = 30)]
        max_backoff: u64,
    },
    /// Alias for copy
    Down {
        #[arg(short, long, env = "COPA_REMOTE")] remote: Option<String>,
        #[arg(long, env = "COPA_SERVER")]        server: Option<String>,
        #[arg(long, env = "COPA_TOKEN")]         token: Option<String>,
        #[arg(long, env = "COPA_NAMESPACE")]     namespace: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")] socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")] session: Option<String>,
        #[arg(short, long)] output: Option<String>,
        #[arg(long)]        output_cmd: Option<String>,
        #[arg(short, long)] verbose: bool,
    },
    /// Alias for paste
    Up {
        #[arg(short, long, env = "COPA_REMOTE")] remote: Option<String>,
        #[arg(long, env = "COPA_SERVER")]        server: Option<String>,
        #[arg(long, env = "COPA_TOKEN")]         token: Option<String>,
        #[arg(long, env = "COPA_NAMESPACE")]     namespace: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")] socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")] session: Option<String>,
        #[arg(short, long)] input: Option<String>,
        #[arg(long)]        input_cmd: Option<String>,
        #[arg(value_name = "TEXT")] text: Option<String>,
        #[arg(short, long)] verbose: bool,
    },
}

// ── main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.print_config_path {
        println!("{}", config_path().display());
        return;
    }

    let cfg = load_config(cli.config);

    match cli.command {
        Commands::Copy { remote, server, token, namespace, socket, session, output, output_cmd, verbose }
        | Commands::Down { remote, server, token, namespace, socket, session, output, output_cmd, verbose } => {
            let r = resolve_remote(&cfg, remote, server, token);
            let r = unwrap_or_exit(r);
            let socket = resolve_socket(socket);
            unwrap_or_exit(do_copy(r, socket, session, namespace, output, output_cmd, verbose));
        }
        Commands::Paste { remote, server, token, namespace, socket, session, input, input_cmd, text, verbose }
        | Commands::Up { remote, server, token, namespace, socket, session, input, input_cmd, text, verbose } => {
            let r = resolve_remote(&cfg, remote, server, token);
            let r = unwrap_or_exit(r);
            let socket = resolve_socket(socket);
            unwrap_or_exit(do_paste(r, socket, session, namespace, input, input_cmd, text, verbose));
        }
        Commands::Watch { remote, server, token, namespace, socket, session, output, output_cmd, max_backoff } => {
            let r = resolve_remote(&cfg, remote, server, token);
            let r = unwrap_or_exit(r);
            let socket = resolve_socket(socket);
            do_watch(r.url, r.token, namespace, socket, session, output, output_cmd, max_backoff).await;
        }
    }
}

fn resolve_remote(
    cfg: &ConfigFile,
    remote: Option<String>,
    server: Option<String>,
    token: Option<String>,
) -> Result<Remote, String> {
    // --server + --token always wins
    if let (Some(url), Some(tok)) = (server, token) {
        return Ok(Remote { url, token: tok, headers: HashMap::new() });
    }
    let r = get_remote(cfg, remote)?;
    Ok(r)
}

fn unwrap_or_exit<T>(r: Result<T, String>) -> T {
    r.unwrap_or_else(|e| { eprintln!("error: {e}"); std::process::exit(1); })
}

