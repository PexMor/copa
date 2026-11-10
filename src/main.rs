/// copasrv — clipboard-over-HTTP server with namespace support and WebSocket push
use clap::Parser;
use copa::server::{
    config::{load_config, ServerConfig},
    serve,
    state::build_app_state,
};
use copa::storage::{Storage, SECRET_ENV};
use copa::{config_path, gen_token, now_ms};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};

#[derive(Parser, Debug)]
#[command(name = "copasrv", version = copa::version::LONG, about = "copa server — clipboard over HTTP with namespace support")]
struct Cli {
    #[arg(short, long, env = "COPA_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long)]
    print_config_path: bool,
    #[arg(long)]
    generate_token: bool,
    #[arg(short, long, env = "COPA_PORT")]
    port: Option<u16>,
    #[arg(short, long, env = "COPA_BIND")]
    bind: Option<String>,
    /// Legacy: sets the rw_token for the auto-created "default" namespace.
    #[arg(short, long, env = "COPA_TOKEN")]
    token: Option<String>,
    /// Web app (built frontend) directory. Env: COPA_STATIC_DIR.
    /// Default: <exe dir>/../share/copa/dist, then ~/.local/share/copa/dist
    #[arg(long, env = "COPA_STATIC_DIR")]
    static_dir: Option<PathBuf>,
}

fn resolve_static_dir(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = explicit {
        if !dir.join("index.html").is_file() {
            die(&format!("static dir '{}' has no index.html (build it: make install-web)", dir.display()));
        }
        return dir.canonicalize().unwrap_or(dir);
    }
    let exe = std::env::current_exe().ok();
    let xdg = std::env::var("XDG_DATA_HOME").ok();
    let home = std::env::var("HOME").ok();
    match copa::server::static_assets::find_default(exe.as_deref(), xdg.as_deref(), home.as_deref()) {
        Ok(dir) => dir,
        Err(tried) => {
            let list = tried.iter().map(|p| format!("  {}", p.display())).collect::<Vec<_>>().join("\n");
            die(&format!(
                "no web app found. Set --static-dir / COPA_STATIC_DIR, or install it (make install-web). Looked in:\n{list}"
            ))
        }
    }
}

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.print_config_path {
        println!("{}", config_path().display());
        return;
    }
    if cli.generate_token {
        println!("{}", gen_token());
        return;
    }

    let cfg = load_config(cli.config);
    let port = cli.port.or(cfg.server.port).unwrap_or(8080);
    let bind = cli.bind.or(cfg.server.bind).unwrap_or_else(|| "127.0.0.1".to_string());

    // CLI --token overrides config server.token (legacy path)
    let effective_srv = ServerConfig {
        port: Some(port),
        bind: Some(bind.clone()),
        token: cli.token.or(cfg.server.token),
        ..cfg.server
    };

    let static_dir = resolve_static_dir(cli.static_dir.clone());

    let storage = match &effective_srv.storage {
        None => None,
        Some(storage_cfg) => match Storage::from_config(storage_cfg, std::env::var(SECRET_ENV).ok()) {
            Ok((storage, warnings)) => {
                for w in warnings {
                    eprintln!("warning: {w}");
                }
                eprintln!("files: enabled (key prefix '{}')", storage.key_prefix());
                Some(Arc::new(storage))
            }
            Err(e) => die(&e),
        },
    };

    let state = build_app_state(&effective_srv, storage, Arc::new(now_ms), port, &bind)
        .unwrap_or_else(|e| die(&e));

    let addr: SocketAddr = format!("{bind}:{port}").parse().unwrap_or_else(|_| die("bad bind address"));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| die(&format!("bind {addr} failed: {e}")));
    eprintln!("copasrv {} (protocol {})", copa::version::LONG, copa::version::PROTOCOL);
    eprintln!("listening on http://{addr}");
    eprintln!("web app: {} (static dir)", static_dir.display());
    if let Err(e) = serve(listener, state, Some(static_dir)).await {
        die(&e);
    }
}
