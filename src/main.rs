/// copa: clipboard over HTTP with token auth (tmux buffer + server clipboard)
use clap::{Parser, Subcommand};
use hyper::{body::to_bytes, service::{make_service_fn, service_fn}, Body, Method, Request, Response, Server};
use rand::Rng;
use serde::Deserialize;
use std::{collections::HashMap, convert::Infallible, io::Read, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Debug, Clone)]
struct Remote {
    url: String,
    token: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Deserialize, Default, Debug)]
struct ConfigFile {
    #[serde(default)]
    server: ServerConfig,
    #[serde(default)]
    cli: CliConfig,
}

#[derive(Deserialize, Default, Debug)]
struct CliConfig {
    #[serde(default)]
    remotes: HashMap<String, Remote>,
    default_remote: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct ServerConfig {
    port: Option<u16>,
    bind: Option<String>,
    token: Option<String>,
    socket: Option<String>,
    session: Option<String>,
}

fn config_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".config").join("copa").join("config.toml")
}

fn load_config() -> ConfigFile {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => toml::from_str(&content).unwrap_or_else(|e| {
            eprintln!("warning: failed to parse {}: {e}", path.display());
            eprintln!("using default empty config");
            ConfigFile::default()
        }),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("warning: failed to read {}: {e}", path.display());
            }
            ConfigFile::default()
        }
    }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "copa - clipboard over HTTP",
    long_about = "copa - clipboard over HTTP with token auth (tmux buffer + server clipboard)\n\n\
                  Examples:\n  \
                  copa serve                           Start HTTP server\n  \
                  copa cli copy                        Download → tmux buffer\n  \
                  copa cli paste                       Upload tmux buffer → remote\n  \
                  copa cli copy -o file.txt            Download → file\n  \
                  copa cli copy -o -                   Download → stdout\n  \
                  copa cli copy --output-cmd pbcopy    Download → macOS clipboard\n  \
                  copa cli copy --output-cmd 'xsel -ib'  Download → X11 clipboard\n  \
                  copa cli copy --output-cmd wl-copy   Download → Wayland clipboard\n  \
                  copa cli paste -i file.txt           Upload file → remote\n  \
                  copa cli paste --input-cmd pbpaste   Upload macOS clipboard → remote\n  \
                  copa cli paste --input-cmd 'xsel -ob'  Upload X11 clipboard → remote\n  \
                  copa cli paste --input-cmd wl-paste  Upload Wayland clipboard → remote\n  \
                  echo data | copa cli up              Upload stdin → remote"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
    #[arg(short, long, env = "COPA_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long)]
    print_config_path: bool,
    #[arg(long)]
    generate_token: bool,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Start the HTTP server
    Serve {
        #[arg(short, long, env = "COPA_PORT")]
        port: Option<u16>,
        #[arg(short, long, env = "COPA_BIND")]
        bind: Option<String>,
        #[arg(short, long, env = "COPA_TOKEN")]
        token: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(long, env = "COPA_NO_TMUX")]
        no_tmux: bool,
    },
    /// CLI client operations
    Cli {
        #[command(subcommand)]
        action: CliAction,
    },
}

#[derive(Subcommand, Debug)]
enum CliAction {
    /// Copy from remote server to tmux buffer
    Copy {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
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
    /// Paste from tmux buffer to remote server
    Paste {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
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
    /// Download from remote server to tmux buffer (alias for copy)
    Down {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
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
    /// Upload from tmux buffer to remote server (alias for paste)
    Up {
        #[arg(short, long, env = "COPA_REMOTE")]
        remote: Option<String>,
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
}

// ── tmux helpers ──────────────────────────────────────────────────────────────

fn tmux_get_buffer(socket_path: &str, session: &Option<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("tmux");
    cmd.arg("-S").arg(socket_path);
    if let Some(s) = session { cmd.arg("-t").arg(s); }
    cmd.arg("show-buffer");
    let out = cmd.output().map_err(|e| format!("exec: {e}"))?;
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

fn tmux_set_buffer(socket_path: &str, session: &Option<String>, data: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("tmux");
    cmd.arg("-S").arg(socket_path);
    if let Some(s) = session { cmd.arg("-t").arg(s); }
    cmd.arg("set-buffer").arg(data);
    let out = cmd.output().map_err(|e| format!("exec: {e}"))?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

fn resolve_socket(cli_val: Option<String>) -> String {
    if let Some(s) = cli_val { return s; }
    if let Ok(tmux) = std::env::var("TMUX") {
        if let Some(p) = tmux.split(',').next() { return p.to_string(); }
    }
    format!("/tmp/tmux-{}/default", unsafe { libc::getuid() })
}

// ── Server ────────────────────────────────────────────────────────────────────

struct AppState {
    token: String,
    socket_path: Option<String>,
    session: Option<String>,
    clipboard: RwLock<String>,
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn cors(mut r: Response<Body>) -> Response<Body> {
    let h = r.headers_mut();
    h.insert("access-control-allow-origin", "*".parse().unwrap());
    h.insert("access-control-allow-headers", "authorization, content-type".parse().unwrap());
    h.insert("access-control-allow-methods", "GET, POST, OPTIONS".parse().unwrap());
    r
}

fn json_resp(status: u16, body: &str) -> Response<Body> {
    cors(Response::builder().status(status).header("Content-Type", "application/json").body(Body::from(body.to_string())).unwrap())
}

async fn handle(req: Request<Body>, st: Arc<AppState>) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path().to_owned();
    let method = req.method().clone();

    if method == Method::OPTIONS {
        return Ok(cors(Response::builder().status(204).body(Body::empty()).unwrap()));
    }

    if method == Method::GET && (path == "/" || path.is_empty()) {
        eprintln!("{} {} 200", method, path);
        return Ok(cors(Response::builder().status(200).header("Content-Type", "text/html; charset=utf-8").body(Body::from(HTML)).unwrap()));
    }

    if method == Method::GET && path == "/icon.svg" {
        return Ok(cors(Response::builder().status(200).header("Content-Type", "image/svg+xml").header("Cache-Control", "public, max-age=86400").body(Body::from(ICON_SVG)).unwrap()));
    }

    if method == Method::GET && path == "/manifest.json" {
        return Ok(cors(Response::builder().status(200).header("Content-Type", "application/manifest+json").header("Cache-Control", "public, max-age=86400").body(Body::from(MANIFEST_JSON)).unwrap()));
    }

    if path.starts_with("/api/") {
        let authed = req.headers().get("authorization").and_then(|v| v.to_str().ok()).map(|v| v == format!("Bearer {}", st.token)).unwrap_or(false);
        if !authed {
            eprintln!("{} {} 401 unauthorized", method, path);
            return Ok(json_resp(401, r#"{"error":"unauthorized"}"#));
        }

        if method == Method::GET && path == "/api/buffer" {
            if let Some(socket) = &st.socket_path {
                return Ok(match tmux_get_buffer(socket, &st.session) {
                    Ok(c) => {
                        eprintln!("{} {} 200 {} bytes", method, path, c.len());
                        json_resp(200, &format!(r#"{{"content":{}}}"#, json_str(&c)))
                    }
                    Err(e) => {
                        eprintln!("{} {} 500 {}", method, path, e);
                        json_resp(500, &format!(r#"{{"error":{}}}"#, json_str(&e)))
                    }
                });
            } else {
                eprintln!("{} {} 503 tmux integration disabled", method, path);
                return Ok(json_resp(503, r#"{"error":"tmux integration disabled"}"#));
            }
        }

        if method == Method::POST && path == "/api/buffer" {
            if let Some(socket) = &st.socket_path {
                let bytes = to_bytes(req.into_body()).await.unwrap_or_default();
                let text = String::from_utf8_lossy(&bytes).into_owned();
                return Ok(match tmux_set_buffer(socket, &st.session, &text) {
                    Ok(()) => {
                        eprintln!("{} {} 200 pushed {} bytes", method, path, text.len());
                        json_resp(200, r#"{"ok":true}"#)
                    }
                    Err(e) => {
                        eprintln!("{} {} 500 {}", method, path, e);
                        json_resp(500, &format!(r#"{{"error":{}}}"#, json_str(&e)))
                    }
                });
            } else {
                eprintln!("{} {} 503 tmux integration disabled", method, path);
                return Ok(json_resp(503, r#"{"error":"tmux integration disabled"}"#));
            }
        }

        if method == Method::GET && path == "/api/clipboard" {
            let content = st.clipboard.read().await.clone();
            eprintln!("{} {} 200 {} bytes", method, path, content.len());
            return Ok(cors(Response::builder().status(200).header("Content-Type", "text/plain; charset=utf-8").body(Body::from(content)).unwrap()));
        }

        if method == Method::POST && path == "/api/clipboard" {
            let bytes = to_bytes(req.into_body()).await.unwrap_or_default();
            let text = String::from_utf8_lossy(&bytes).into_owned();
            eprintln!("{} {} 200 stored {} bytes", method, path, text.len());
            *st.clipboard.write().await = text;
            return Ok(cors(Response::builder().status(200).header("Content-Type", "text/plain").body(Body::from("ok")).unwrap()));
        }
    }

    eprintln!("{} {} 404", method, path);
    Ok(cors(Response::builder().status(404).body(Body::from("not found")).unwrap()))
}

const HTML: &str = include_str!("../web/ui.html");

const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="20" fill="#7c6af7"/>
<rect x="16" y="28" width="44" height="54" rx="8" fill="white" fill-opacity="0.28"/>
<rect x="28" y="20" width="44" height="58" rx="8" fill="white"/>
<rect x="40" y="15" width="20" height="11" rx="4" fill="white"/>
<rect x="37" y="36" width="28" height="5" rx="2.5" fill="#7c6af7"/>
<rect x="37" y="47" width="22" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
<rect x="37" y="58" width="25" height="5" rx="2.5" fill="#7c6af7" opacity="0.55"/>
</svg>"##;

const MANIFEST_JSON: &str = r##"{"name":"copa","short_name":"copa","description":"Clipboard over HTTP","start_url":"/","display":"standalone","background_color":"#0f1117","theme_color":"#7c6af7","permissions":["clipboard-read","clipboard-write"],"icons":[{"src":"/icon.svg","type":"image/svg+xml","sizes":"any","purpose":"any maskable"}]}"##;

fn gen_token() -> String {
    let b: [u8; 16] = rand::thread_rng().gen();
    hex::encode(b)
}

async fn run_server(port: u16, bind: String, token: String, socket: Option<String>, session: Option<String>) {
    let state = Arc::new(AppState { token: token.clone(), socket_path: socket.clone(), session, clipboard: RwLock::new(String::new()) });
    let addr: SocketAddr = format!("{}:{}", bind, port).parse().expect("bad addr");
    let make_svc = make_service_fn(move |_| {
        let st = state.clone();
        async move { Ok::<_, Infallible>(service_fn(move |req| handle(req, st.clone()))) }
    });
    if socket.is_some() {
        eprintln!("tmux integration: enabled");
    } else {
        eprintln!("tmux integration: disabled");
    }
    eprintln!("URL:  http://{}:{}/#token={token}", bind, port);
    Server::bind(&addr).serve(make_svc).await.expect("server error");
}

// ── CLI client ────────────────────────────────────────────────────────────────

fn get_remote(cfg: &ConfigFile, name: Option<String>) -> Result<Remote, String> {
    let remote_name = name.or_else(|| cfg.cli.default_remote.clone()).ok_or_else(|| {
        format!("no remote specified and no default_remote in [cli] section\nconfig has {} remotes: {:?}",
                cfg.cli.remotes.len(),
                cfg.cli.remotes.keys().collect::<Vec<_>>())
    })?;
    cfg.cli.remotes.get(&remote_name).cloned().ok_or_else(|| format!("remote '{}' not found in [cli.remotes]", remote_name))
}

fn cli_copy(remote: Remote, socket: String, session: Option<String>, output: Option<String>, output_cmd: Option<String>, verbose: bool) -> Result<(), String> {
    eprintln!("→ downloading from {}/api/clipboard", remote.url);
    let mut req = ureq::get(&format!("{}/api/clipboard", remote.url)).set("Authorization", &format!("Bearer {}", remote.token));
    for (k, v) in &remote.headers {
        if verbose {
            eprintln!("  header: {}: {}", k, v);
        } else {
            eprintln!("  header: {}", k);
        }
        req = req.set(k, v);
    }
    let resp = req.call().map_err(|e| format!("request failed: {e}"))?;
    let text = resp.into_string().map_err(|e| format!("read failed: {e}"))?;
    eprintln!("← received {} bytes", text.len());

    if let Some(cmd) = output_cmd {
        eprintln!("→ piping to command: {}", cmd);
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() { return Err("empty command".to_string()); }
        let mut child = std::process::Command::new(parts[0])
            .args(&parts[1..])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {}: {}", cmd, e))?;
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(text.as_bytes()).map_err(|e| format!("write to {}: {}", cmd, e))?;
        let status = child.wait().map_err(|e| format!("wait {}: {}", cmd, e))?;
        if !status.success() { return Err(format!("command '{}' failed with {}", cmd, status)); }
        eprintln!("✓ piped {} bytes to command", text.len());
    } else {
        match output.as_deref() {
            Some("-") => {
                eprintln!("→ writing to stdout");
                print!("{}", text);
                eprintln!("✓ wrote {} bytes to stdout", text.len());
            }
            Some(path) => {
                eprintln!("→ writing to file: {}", path);
                std::fs::write(path, &text).map_err(|e| format!("write to {}: {}", path, e))?;
                eprintln!("✓ wrote {} bytes to {}", text.len(), path);
            }
            None => {
                eprintln!("→ writing to tmux buffer (socket: {})", socket);
                tmux_set_buffer(&socket, &session, &text)?;
                eprintln!("✓ copied {} bytes from remote to tmux buffer", text.len());
            }
        }
    }
    Ok(())
}

fn cli_paste(remote: Remote, socket: String, session: Option<String>, input: Option<String>, input_cmd: Option<String>, text: Option<String>, verbose: bool) -> Result<(), String> {
    let data = if let Some(t) = text {
        eprintln!("→ using text from CLI argument ({} bytes)", t.len());
        t
    } else if let Some(cmd) = input_cmd {
        eprintln!("→ running command: {}", cmd);
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() { return Err("empty command".to_string()); }
        let output = std::process::Command::new(parts[0])
            .args(&parts[1..])
            .output()
            .map_err(|e| format!("run {}: {}", cmd, e))?;
        if !output.status.success() {
            return Err(format!("command '{}' failed with {}", cmd, output.status));
        }
        let buf = String::from_utf8_lossy(&output.stdout).into_owned();
        eprintln!("← read {} bytes from command", buf.len());
        buf
    } else if let Some(path) = input {
        if path == "-" {
            eprintln!("→ reading from stdin");
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("stdin read: {e}"))?;
            eprintln!("← read {} bytes from stdin", buf.len());
            buf
        } else {
            eprintln!("→ reading from file: {}", path);
            let buf = std::fs::read_to_string(&path).map_err(|e| format!("read from {}: {}", path, e))?;
            eprintln!("← read {} bytes from {}", buf.len(), path);
            buf
        }
    } else if atty::isnt(atty::Stream::Stdin) {
        eprintln!("→ reading from stdin");
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("stdin read: {e}"))?;
        eprintln!("← read {} bytes from stdin", buf.len());
        buf
    } else {
        eprintln!("→ reading from tmux buffer (socket: {})", socket);
        let buf = tmux_get_buffer(&socket, &session)?;
        eprintln!("← read {} bytes from tmux", buf.len());
        buf
    };
    eprintln!("→ uploading to {}/api/clipboard", remote.url);
    let mut req = ureq::post(&format!("{}/api/clipboard", remote.url)).set("Authorization", &format!("Bearer {}", remote.token));
    for (k, v) in &remote.headers {
        if verbose {
            eprintln!("  header: {}: {}", k, v);
        } else {
            eprintln!("  header: {}", k);
        }
        req = req.set(k, v);
    }
    req.send_string(&data).map_err(|e| format!("request failed: {e}"))?;
    eprintln!("✓ pasted {} bytes to remote", data.len());
    Ok(())
}

// ── main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if cli.print_config_path { println!("{}", config_path().display()); return; }
    if cli.generate_token { println!("{}", gen_token()); return; }

    let cfg = load_config();

    match cli.command {
        None => {
            Cli::parse_from(&["copa", "--help"]);
        }
        Some(Commands::Serve { port, bind, token, socket, session, no_tmux }) => {
            let port = port.or(cfg.server.port).unwrap_or(8080);
            let bind = bind.or(cfg.server.bind).unwrap_or_else(|| "127.0.0.1".to_string());
            let token = token.or(cfg.server.token).unwrap_or_else(|| {
                let t = gen_token();
                eprintln!("token: {t}");
                eprintln!("hint: save to {} under [server]", config_path().display());
                t
            });
            let socket_path = if no_tmux {
                None
            } else {
                let s = resolve_socket(socket.or(cfg.server.socket));
                eprintln!("tmux socket: {}", s);
                Some(s)
            };
            run_server(port, bind, token, socket_path, session.or(cfg.server.session)).await;
        }
        Some(Commands::Cli { action }) => {
            match action {
                CliAction::Copy { remote, socket, session, output, output_cmd, verbose } | CliAction::Down { remote, socket, session, output, output_cmd, verbose } => {
                    let r = get_remote(&cfg, remote).unwrap_or_else(|e| { eprintln!("error: {e}"); std::process::exit(1); });
                    let socket = resolve_socket(socket.or(cfg.server.socket));
                    if let Err(e) = cli_copy(r, socket, session.or(cfg.server.session), output, output_cmd, verbose) {
                        eprintln!("error: {e}");
                        std::process::exit(1);
                    }
                }
                CliAction::Paste { remote, socket, session, input, input_cmd, text, verbose } | CliAction::Up { remote, socket, session, input, input_cmd, text, verbose } => {
                    let r = get_remote(&cfg, remote).unwrap_or_else(|e| { eprintln!("error: {e}"); std::process::exit(1); });
                    let socket = resolve_socket(socket.or(cfg.server.socket));
                    if let Err(e) = cli_paste(r, socket, session.or(cfg.server.session), input, input_cmd, text, verbose) {
                        eprintln!("error: {e}");
                        std::process::exit(1);
                    }
                }
            }
        }
    }
}
