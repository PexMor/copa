/// copacli — local client for copasrv
///
/// Subcommands:
///   copy      one-shot: GET clipboard → output (tmux/file/cmd/stdout)
///   paste     one-shot: input (tmux/file/cmd/stdin) → POST clipboard
///   watch     persistent: WebSocket → output (tmux/file/cmd/stdout), auto-reconnects
///   down      alias for copy
///   up        alias for paste
///   put       one-shot: upload a file as a file item (via presigned URL)
///   get       one-shot: download a file item (default: newest)
///   history   list / rm / clear server-side history items
///   mqtt-pub  one-shot: input → encrypt → MQTT publish (retain, QoS-1)
///   mqtt-get  one-shot: MQTT subscribe → first retained msg → decrypt → output
///   mqtt-sub  persistent: MQTT subscribe → decrypt → output, auto-reconnects
use clap::{Parser, Subcommand};
use copa::{config_path, load_config_file, now_ms, sanitize_filename, mqtt::{MqttServerCfg, build_mqtt_options, default_max_message_size, mqtt_client_id, mqtt_decrypt, mqtt_encrypt}};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{collections::HashMap, io::Read, io::IsTerminal, path::{Path, PathBuf}};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use rumqttc::{AsyncClient, Event, Packet, QoS};

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
    #[serde(default)]
    mqtt_servers: HashMap<String, MqttServerCfg>,
    default_mqtt_server: Option<String>,
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

fn get_mqtt_server(cfg: &ConfigFile, name: Option<String>) -> Result<MqttServerCfg, String> {
    let name = name
        .or_else(|| cfg.cli.default_mqtt_server.clone())
        .ok_or_else(|| format!(
            "no mqtt-server specified and no default_mqtt_server in [cli] section\n\
             config has {} mqtt_servers: {:?}",
            cfg.cli.mqtt_servers.len(),
            cfg.cli.mqtt_servers.keys().collect::<Vec<_>>()
        ))?;
    cfg.cli.mqtt_servers.get(&name).cloned()
        .ok_or_else(|| format!("mqtt_server '{name}' not found in [cli.mqtt_servers]"))
}

fn resolve_mqtt_server(
    cfg: &ConfigFile,
    mqtt_server: Option<String>,
    broker: Option<String>,
    topic: Option<String>,
    key: Option<String>,
) -> Result<MqttServerCfg, String> {
    if let (Some(b), Some(t)) = (broker, topic) {
        return Ok(MqttServerCfg {
            broker_url: b,
            topic: t,
            aes_key: key,
            max_message_size: default_max_message_size(),
            client_id: None,
        });
    }
    let mut srv = get_mqtt_server(cfg, mqtt_server)?;
    if key.is_some() { srv.aes_key = key; }
    Ok(srv)
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
    item: Option<String>,
    verbose: bool,
) -> Result<(), String> {
    if let Some(id) = item {
        let api = Api { remote, namespace };
        eprintln!("→ downloading item {id} from {}", api.remote.url);
        let text = match api.req("GET", &format!("/api/history/{id}")).call() {
            Ok(resp) => resp.into_string().map_err(|e| format!("read failed: {e}"))?,
            Err(ureq::Error::Status(409, _)) => {
                return Err(format!("item {id} is a file — use: copacli get {id}"));
            }
            Err(ureq::Error::Status(404, _)) => {
                return Err(format!("item {id} was not found or has expired"));
            }
            Err(e) => return Err(api_error(e)),
        };
        eprintln!("← received {} bytes", text.len());
        return route_output(&text, &output_cmd, &output, &socket, &session);
    }
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


// ── MQTT operations ───────────────────────────────────────────────────────────

async fn do_mqtt_pub(
    srv: MqttServerCfg,
    socket: String,
    session: Option<String>,
    text_arg: Option<String>,
    input: Option<String>,
    input_cmd: Option<String>,
) -> Result<(), String> {
    let data = route_input(&text_arg, &input_cmd, &input, &socket, &session)?;

    let payload = match &srv.aes_key {
        Some(key) => mqtt_encrypt(&data, key)?,
        None => {
            eprintln!("warning: no aes_key configured — publishing plaintext");
            data.clone()
        }
    };

    if payload.len() > srv.max_message_size {
        return Err(format!(
            "payload too large ({} > {} bytes)",
            payload.len(), srv.max_message_size
        ));
    }

    let cid = mqtt_client_id(&srv.client_id);
    let opts = build_mqtt_options(&srv.broker_url, &cid)?;
    let (client, mut evloop) = AsyncClient::new(opts, 16);

    eprintln!("→ connecting to {}", srv.broker_url);
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        async {
            let mut published = false;
            loop {
                match evloop.poll().await.map_err(|e| e.to_string())? {
                    Event::Incoming(Packet::ConnAck(_)) => {
                        eprintln!("→ connected; publishing {} bytes to {}", payload.len(), srv.topic);
                        client
                            .publish(&srv.topic, QoS::AtLeastOnce, true, payload.as_bytes())
                            .await
                            .map_err(|e| e.to_string())?;
                        published = true;
                    }
                    Event::Incoming(Packet::PubAck(_)) if published => {
                        eprintln!("✓ published and acknowledged");
                        client.disconnect().await.ok();
                        return Ok(());
                    }
                    _ => {}
                }
            }
        },
    )
    .await
    .map_err(|_| "mqtt-pub timed out after 20s".to_string())
    .and_then(|r: Result<(), String>| r)
}

async fn do_mqtt_get(
    srv: MqttServerCfg,
    socket: String,
    session: Option<String>,
    output: Option<String>,
    output_cmd: Option<String>,
) -> Result<(), String> {
    if srv.aes_key.is_none() {
        eprintln!("warning: no aes_key configured — message will not be decrypted");
    }

    let cid = mqtt_client_id(&srv.client_id);
    let opts = build_mqtt_options(&srv.broker_url, &cid)?;
    let (client, mut evloop) = AsyncClient::new(opts, 16);

    eprintln!("→ connecting to {}", srv.broker_url);
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        async {
            loop {
                match evloop.poll().await.map_err(|e| e.to_string())? {
                    Event::Incoming(Packet::ConnAck(_)) => {
                        eprintln!("→ connected; subscribing to {}", srv.topic);
                        client
                            .subscribe(&srv.topic, QoS::AtLeastOnce)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    Event::Incoming(Packet::Publish(p)) => {
                        let raw = String::from_utf8_lossy(&p.payload).into_owned();
                        let text = if let Some(ref key) = srv.aes_key {
                            mqtt_decrypt(&raw, key)?
                        } else {
                            raw
                        };
                        eprintln!("← received {} bytes", text.len());
                        client.disconnect().await.ok();
                        return route_output(&text, &output_cmd, &output, &socket, &session);
                    }
                    _ => {}
                }
            }
        },
    )
    .await
    .map_err(|_| "mqtt-get timed out after 20s (no retained message?)".to_string())
    .and_then(|r: Result<(), String>| r)
}

async fn do_mqtt_sub(
    srv: MqttServerCfg,
    socket: String,
    session: Option<String>,
    output: Option<String>,
    output_cmd: Option<String>,
    max_backoff: u64,
) {
    if srv.aes_key.is_none() {
        eprintln!("warning: no aes_key configured — messages will not be decrypted");
    }
    let mut backoff = 1u64;
    loop {
        eprintln!("copacli mqtt-sub: connecting to {}", srv.broker_url);
        match mqtt_sub_once(&srv, &socket, &session, &output, &output_cmd).await {
            Ok(()) => {
                eprintln!("copacli mqtt-sub: connection closed");
                backoff = 1;
            }
            Err(e) => {
                eprintln!("copacli mqtt-sub: error: {e}");
            }
        }
        eprintln!("copacli mqtt-sub: reconnecting in {backoff}s");
        tokio::time::sleep(tokio::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

async fn mqtt_sub_once(
    srv: &MqttServerCfg,
    socket: &str,
    session: &Option<String>,
    output: &Option<String>,
    output_cmd: &Option<String>,
) -> Result<(), String> {
    let cid = mqtt_client_id(&srv.client_id);
    let opts = build_mqtt_options(&srv.broker_url, &cid)?;
    let (client, mut evloop) = AsyncClient::new(opts, 64);

    loop {
        match evloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                eprintln!("copacli mqtt-sub: connected (topic={})", srv.topic);
                client
                    .subscribe(&srv.topic, QoS::AtLeastOnce)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                let raw = String::from_utf8_lossy(&p.payload).into_owned();
                let text = if let Some(ref key) = srv.aes_key {
                    match mqtt_decrypt(&raw, key) {
                        Ok(t) => t,
                        Err(ref e) if e == "not-copa-mqtt" => {
                            eprintln!("copacli mqtt-sub: skipping non-copa message");
                            continue;
                        }
                        Err(e) => {
                            eprintln!("copacli mqtt-sub: decrypt error: {e}");
                            continue;
                        }
                    }
                } else {
                    raw
                };
                if let Err(e) = route_output(&text, output_cmd, output, socket, session) {
                    eprintln!("copacli mqtt-sub: output error: {e}");
                }
            }
            Ok(Event::Incoming(Packet::Disconnect)) => return Ok(()),
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

// ── files and history ─────────────────────────────────────────────────────────

/// A remote plus namespace: builds authenticated requests for the JSON API.
struct Api {
    remote:    Remote,
    namespace: Option<String>,
}

impl Api {
    fn req(&self, method: &str, path: &str) -> ureq::Request {
        let mut req = ureq::request(method, &format!("{}{path}", self.remote.url.trim_end_matches('/')))
            .set("Authorization", &format!("Bearer {}", self.remote.token));
        if let Some(ns) = &self.namespace { req = req.set("X-Copa-Namespace", ns); }
        for (k, v) in &self.remote.headers { req = req.set(k, v); }
        req
    }

    fn get_json(&self, path: &str) -> Result<serde_json::Value, ureq::Error> {
        let resp = self.req("GET", path).call()?;
        resp.into_json().map_err(ureq::Error::from)
    }
}

/// Human-readable error, using the server's `{"error": …}` message if present.
fn api_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["error"].as_str().map(str::to_owned))
                .unwrap_or(body);
            match code {
                401 => "unauthorized — the token lacks the required permission for this namespace".into(),
                _ if msg.trim().is_empty() => format!("server returned {code}"),
                _ => format!("server returned {code}: {}", msg.trim()),
            }
        }
        ureq::Error::Transport(t) => format!("request failed: {t}"),
    }
}

fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.1} {}", UNITS[unit]) }
}

fn format_remaining(ms: u64) -> String {
    let secs = ms / 1000;
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m{:02}s", secs / 60, secs % 60),
        3600..=86_399 => format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60),
        _ => format!("{}d{:02}h", secs / 86_400, (secs % 86_400) / 3600),
    }
}

/// Declared content type (metadata only), from the file extension.
fn guess_content_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => return None,
    })
}

fn do_put(api: Api, file: PathBuf, name: Option<String>, ttl: Option<u64>) -> Result<(), String> {
    let meta = std::fs::metadata(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", file.display()));
    }
    let size = meta.len();
    let name = sanitize_filename(&name.unwrap_or_else(|| {
        file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }));

    let mut body = serde_json::json!({ "name": name, "size": size });
    if let Some(t) = guess_content_type(&name) { body["content_type"] = t.into(); }
    if let Some(t) = ttl { body["ttl_secs"] = t.into(); }

    eprintln!("→ requesting upload of {name} ({}) at {}", format_size(size), api.remote.url);
    let grant: serde_json::Value = match api.req("POST", "/api/files").send_json(body) {
        Ok(resp) => resp.into_json().map_err(|e| format!("bad response: {e}"))?,
        Err(ureq::Error::Status(404 | 405, _)) => {
            return Err("the server does not support files (not enabled on this server or namespace)".into());
        }
        Err(ureq::Error::Status(413, _)) => {
            let limit = api.get_json("/api/capabilities").ok().and_then(|c| c["max_file_size"].as_u64());
            return Err(match limit {
                Some(l) => format!("file is too large: {} exceeds the server limit of {}", format_size(size), format_size(l)),
                None => "file is too large for this server".into(),
            });
        }
        Err(ureq::Error::Status(507, _)) => {
            return Err("the namespace's file storage quota is exhausted — remove items (copacli history rm) or wait for them to expire".into());
        }
        Err(e) => return Err(api_error(e)),
    };
    let id = grant["id"].as_str().ok_or("bad response: no id")?.to_owned();
    let url = grant["upload_url"].as_str().ok_or("bad response: no upload_url")?;

    // Stream from disk straight to the object store. The headers are part of
    // the URL's signature and must be sent exactly as given.
    let mut put = ureq::request(grant["method"].as_str().unwrap_or("PUT"), url);
    if let Some(headers) = grant["headers"].as_object() {
        for (k, v) in headers {
            put = put.set(k, v.as_str().unwrap_or_default());
        }
    }
    let reader = std::fs::File::open(&file).map_err(|e| format!("{}: {e}", file.display()))?;
    eprintln!("→ uploading {} to object store", format_size(size));
    match put.send(reader) {
        Ok(_) => {}
        Err(ureq::Error::Status(code, _)) => return Err(format!("upload failed: object store returned {code}")),
        Err(ureq::Error::Transport(t)) => return Err(format!("upload failed: {}", t.kind())),
    }

    match api.req("POST", &format!("/api/files/{id}/complete")).call() {
        Ok(_) => {}
        Err(e) => return Err(format!("upload could not be completed: {}", api_error(e))),
    }
    eprintln!("✓ uploaded {name} ({})", format_size(size));
    println!("{id}");
    Ok(())
}

/// Where a downloaded item goes. The item name is reduced to a single safe
/// path component, so the result is always directly inside the chosen directory.
fn resolve_dest(output: Option<&str>, item_name: &str) -> PathBuf {
    let safe = sanitize_filename(item_name);
    match output {
        None => PathBuf::from(".").join(safe),
        Some(path) if Path::new(path).is_dir() => Path::new(path).join(safe),
        Some(path) => PathBuf::from(path),
    }
}

fn do_get(api: Api, id: Option<String>, output: Option<String>, force: bool) -> Result<(), String> {
    let id = match id {
        Some(id) => id,
        None => {
            let items = api.get_json("/api/history").map_err(|e| match e {
                ureq::Error::Status(404 | 405, _) => "the server does not support history or files".to_owned(),
                e => api_error(e),
            })?;
            items
                .as_array()
                .and_then(|a| a.iter().find(|i| i["kind"] == "file"))
                .and_then(|i| i["id"].as_str())
                .ok_or("no file is available in this namespace")?
                .to_owned()
        }
    };

    let info = match api.get_json(&format!("/api/files/{id}")) {
        Ok(v) => v,
        Err(ureq::Error::Status(409, _)) => {
            return Err(format!("item {id} is text — use: copacli copy --item {id}"));
        }
        Err(ureq::Error::Status(404, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            return Err(if body.contains("files not enabled") || !body.contains("error") {
                "the server does not support files (not enabled on this server or namespace)".into()
            } else {
                format!("item {id} was not found or has expired")
            });
        }
        Err(e) => return Err(api_error(e)),
    };
    let url = info["download_url"].as_str().ok_or("bad response: no download_url")?;
    let name = info["name"].as_str().unwrap_or("file");
    let size = info["size"].as_u64().unwrap_or(0);

    let fetch = || match ureq::get(url).call() {
        Ok(resp) => Ok(resp.into_reader()),
        Err(ureq::Error::Status(code, _)) => Err(format!("download failed: object store returned {code}")),
        Err(ureq::Error::Transport(t)) => Err(format!("download failed: {}", t.kind())),
    };

    if output.as_deref() == Some("-") {
        let mut reader = fetch()?;
        let n = std::io::copy(&mut reader, &mut std::io::stdout().lock()).map_err(|e| format!("download failed: {e}"))?;
        eprintln!("✓ wrote {} to stdout", format_size(n));
        return Ok(());
    }

    let dest = resolve_dest(output.as_deref(), name);
    if dest.exists() && !force {
        return Err(format!("{} already exists (use --force to overwrite)", dest.display()));
    }
    let mut part = dest.clone().into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);

    eprintln!("→ downloading {name} ({})", format_size(size));
    let result = (|| {
        let mut reader = fetch()?;
        let mut file = std::fs::File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
        let n = std::io::copy(&mut reader, &mut file).map_err(|e| format!("download failed: {e}"))?;
        if n != size {
            return Err(format!("download incomplete: got {n} of {size} bytes"));
        }
        file.sync_all().map_err(|e| format!("{}: {e}", part.display()))?;
        if dest.exists() && !force {
            return Err(format!("{} already exists (use --force to overwrite)", dest.display()));
        }
        std::fs::rename(&part, &dest).map_err(|e| format!("{}: {e}", dest.display()))
    })();
    if result.is_err() {
        // never leave a partial file behind
        let _ = std::fs::remove_file(&part);
    }
    result?;
    eprintln!("✓ saved {} ({})", dest.display(), format_size(size));
    Ok(())
}

fn do_history_list(api: Api, json: bool) -> Result<(), String> {
    let resp = api.req("GET", "/api/history").call().map_err(|e| match e {
        ureq::Error::Status(404 | 405, _) => "the server does not support history".to_owned(),
        e => api_error(e),
    })?;
    let body = resp.into_string().map_err(|e| format!("read failed: {e}"))?;
    if json {
        println!("{body}");
        return Ok(());
    }
    let items: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|e| format!("bad response: {e}"))?;
    if items.is_empty() {
        eprintln!("(history is empty)");
        return Ok(());
    }
    let now = now_ms();
    println!("{:<32}  {:<4}  {:>10}  {:>7}  NAME / PREVIEW", "ID", "KIND", "SIZE", "EXPIRES");
    for item in &items {
        let kind = item["kind"].as_str().unwrap_or("?");
        let label = if kind == "file" { item["name"].as_str() } else { item["preview"].as_str() }.unwrap_or("");
        // one line, no control characters
        let label: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).take(60).collect();
        println!(
            "{:<32}  {:<4}  {:>10}  {:>7}  {}",
            item["id"].as_str().unwrap_or("?"),
            kind,
            format_size(item["size"].as_u64().unwrap_or(0)),
            format_remaining(item["expires_at"].as_u64().unwrap_or(0).saturating_sub(now)),
            label.trim_end(),
        );
    }
    Ok(())
}

fn do_history_rm(api: Api, id: String) -> Result<(), String> {
    match api.req("DELETE", &format!("/api/history/{id}")).call() {
        Ok(_) => { eprintln!("✓ removed {id}"); Ok(()) }
        Err(ureq::Error::Status(404, _)) => Err(format!("item {id} was not found or has expired")),
        Err(e) => Err(api_error(e)),
    }
}

fn do_history_clear(api: Api) -> Result<(), String> {
    let resp = api.req("DELETE", "/api/history").call().map_err(api_error)?;
    let n = resp.into_json::<serde_json::Value>().ok().and_then(|v| v["deleted"].as_u64()).unwrap_or(0);
    eprintln!("✓ removed {n} item(s)");
    Ok(())
}

// ── CLI definition ────────────────────────────────────────────────────────────

#[derive(Parser, Debug)]
#[command(
    name = "copacli",
    about = "copa client — copy/paste/watch against a copasrv instance, or pub/get/sub via MQTT",
    long_about = "Examples:\n  \
      copacli copy -r local                          Download → tmux buffer\n  \
      copacli copy -r local --output-cmd pbcopy      Download → macOS clipboard\n  \
      copacli copy -r local --output-cmd 'xsel -ib'  Download → X11 clipboard\n  \
      copacli copy -r local -o -                     Download → stdout\n  \
      copacli paste -r local                         Upload tmux buffer → remote\n  \
      copacli paste -r local --input-cmd pbpaste     Upload macOS clipboard → remote\n  \
      copacli paste -r local 'text'                  Upload literal text → remote\n  \
      echo data | copacli paste -r local             Upload stdin → remote\n  \
      copacli watch -r local                         Live WebSocket → tmux buffer\n  \
      copacli put -r local report.pdf                Upload a file (prints the item id)\n  \
      copacli get -r local                           Download the newest file → ./<name>\n  \
      copacli history -r local                       List server-side history\n  \
      copacli copy -r local --item ID -o -           Older text item → stdout\n  \
      copacli mqtt-pub -m mybroker 'text'            Encrypt + publish to MQTT broker\n  \
      copacli mqtt-get -m mybroker -o -              Get retained MQTT message → stdout\n  \
      copacli mqtt-sub -m mybroker                   Persistent MQTT subscribe → tmux buffer"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
    #[arg(short, long, env = "COPA_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long)]
    print_config_path: bool,
}

/// Which server and namespace to talk to (same resolution as copy/paste).
#[derive(clap::Args, Debug)]
struct Target {
    #[arg(short, long, env = "COPA_REMOTE", global = true)]
    remote: Option<String>,
    #[arg(long, env = "COPA_SERVER", global = true, help = "Server URL (overrides remote config)")]
    server: Option<String>,
    #[arg(long, env = "COPA_TOKEN", global = true, help = "Auth token (overrides remote config)")]
    token: Option<String>,
    #[arg(long, env = "COPA_NAMESPACE", global = true)]
    namespace: Option<String>,
}

#[derive(Subcommand, Debug)]
enum HistoryAction {
    /// Delete one item
    Rm {
        #[arg(value_name = "ID")]
        id: String,
    },
    /// Delete all items of the namespace
    Clear,
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
        #[arg(long, value_name = "ID", help = "Fetch this history item instead of the newest text (see 'copacli history')")]
        item: Option<String>,
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
        #[arg(long, value_name = "ID")] item: Option<String>,
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
    /// Upload a file as a file item (requires file support on the server)
    Put {
        #[command(flatten)]
        target: Target,
        #[arg(value_name = "FILE")]
        file: PathBuf,
        #[arg(long, value_name = "NAME", help = "Name to store instead of the file's own name")]
        name: Option<String>,
        #[arg(long, value_name = "SECS", help = "Expire after this many seconds (capped by the server's TTL)")]
        ttl: Option<u64>,
    },
    /// Download a file item (default: the newest file)
    Get {
        #[command(flatten)]
        target: Target,
        #[arg(value_name = "ID")]
        id: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "File or directory to write to, or '-' for stdout (default: ./<name>)")]
        output: Option<String>,
        #[arg(short, long, help = "Overwrite an existing file")]
        force: bool,
    },
    /// List server-side history (newest first); `rm <ID>` / `clear` delete items
    History {
        #[command(flatten)]
        target: Target,
        #[arg(long, help = "Print the server's JSON listing verbatim")]
        json: bool,
        #[command(subcommand)]
        action: Option<HistoryAction>,
    },
    /// Encrypt and publish to an MQTT broker (retain=true, QoS=1)
    #[command(name = "mqtt-pub")]
    MqttPub {
        #[arg(short = 'm', long, env = "COPA_MQTT_SERVER",
              help = "Named MQTT server from [cli.mqtt_servers.<name>] in config")]
        mqtt_server: Option<String>,
        #[arg(long, env = "COPA_MQTT_BROKER",
              help = "Broker URL: mqtt://, mqtts://, ws://, or wss://")]
        broker: Option<String>,
        #[arg(long, env = "COPA_MQTT_TOPIC")]
        topic: Option<String>,
        #[arg(long, env = "COPA_MQTT_KEY",
              help = "AES-256 key: base64 (44 chars), 64-char hex, or base58")]
        key: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Input from file or stdin ('-')")]
        input: Option<String>,
        #[arg(long, value_name = "CMD", help = "Read input from command")]
        input_cmd: Option<String>,
        #[arg(value_name = "TEXT")]
        text: Option<String>,
    },
    /// Subscribe and receive the first (retained) MQTT message, then disconnect
    #[command(name = "mqtt-get")]
    MqttGet {
        #[arg(short = 'm', long, env = "COPA_MQTT_SERVER")]
        mqtt_server: Option<String>,
        #[arg(long, env = "COPA_MQTT_BROKER")]
        broker: Option<String>,
        #[arg(long, env = "COPA_MQTT_TOPIC")]
        topic: Option<String>,
        #[arg(long, env = "COPA_MQTT_KEY")]
        key: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Output to file or stdout ('-')")]
        output: Option<String>,
        #[arg(long, value_name = "CMD", help = "Pipe output to command")]
        output_cmd: Option<String>,
    },
    /// Persistent MQTT subscription → output, auto-reconnects on disconnect
    #[command(name = "mqtt-sub")]
    MqttSub {
        #[arg(short = 'm', long, env = "COPA_MQTT_SERVER")]
        mqtt_server: Option<String>,
        #[arg(long, env = "COPA_MQTT_BROKER")]
        broker: Option<String>,
        #[arg(long, env = "COPA_MQTT_TOPIC")]
        topic: Option<String>,
        #[arg(long, env = "COPA_MQTT_KEY")]
        key: Option<String>,
        #[arg(short = 'x', long, env = "COPA_SOCKET")]
        socket: Option<String>,
        #[arg(short = 'S', long, env = "COPA_SESSION")]
        session: Option<String>,
        #[arg(short, long, value_name = "PATH", help = "Output to file or stdout ('-')")]
        output: Option<String>,
        #[arg(long, value_name = "CMD", help = "Pipe each received message to command")]
        output_cmd: Option<String>,
        #[arg(long, default_value_t = 30)]
        max_backoff: u64,
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
        Commands::Copy { remote, server, token, namespace, socket, session, output, output_cmd, item, verbose }
        | Commands::Down { remote, server, token, namespace, socket, session, output, output_cmd, item, verbose } => {
            let r = resolve_remote(&cfg, remote, server, token);
            let r = unwrap_or_exit(r);
            let socket = resolve_socket(socket);
            unwrap_or_exit(do_copy(r, socket, session, namespace, output, output_cmd, item, verbose));
        }
        Commands::Put { target, file, name, ttl } => {
            unwrap_or_exit(do_put(resolve_api(&cfg, target), file, name, ttl));
        }
        Commands::Get { target, id, output, force } => {
            unwrap_or_exit(do_get(resolve_api(&cfg, target), id, output, force));
        }
        Commands::History { target, json, action } => {
            let api = resolve_api(&cfg, target);
            unwrap_or_exit(match action {
                None => do_history_list(api, json),
                Some(HistoryAction::Rm { id }) => do_history_rm(api, id),
                Some(HistoryAction::Clear) => do_history_clear(api),
            });
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
        Commands::MqttPub { mqtt_server, broker, topic, key, socket, session, input, input_cmd, text } => {
            let srv = resolve_mqtt_server(&cfg, mqtt_server, broker, topic, key);
            let srv = unwrap_or_exit(srv);
            let socket = resolve_socket(socket);
            unwrap_or_exit(do_mqtt_pub(srv, socket, session, text, input, input_cmd).await);
        }
        Commands::MqttGet { mqtt_server, broker, topic, key, socket, session, output, output_cmd } => {
            let srv = resolve_mqtt_server(&cfg, mqtt_server, broker, topic, key);
            let srv = unwrap_or_exit(srv);
            let socket = resolve_socket(socket);
            unwrap_or_exit(do_mqtt_get(srv, socket, session, output, output_cmd).await);
        }
        Commands::MqttSub { mqtt_server, broker, topic, key, socket, session, output, output_cmd, max_backoff } => {
            let srv = resolve_mqtt_server(&cfg, mqtt_server, broker, topic, key);
            let srv = unwrap_or_exit(srv);
            let socket = resolve_socket(socket);
            do_mqtt_sub(srv, socket, session, output, output_cmd, max_backoff).await;
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

fn resolve_api(cfg: &ConfigFile, target: Target) -> Api {
    let remote = unwrap_or_exit(resolve_remote(cfg, target.remote, target.server, target.token));
    Api { remote, namespace: target.namespace }
}

fn unwrap_or_exit<T>(r: Result<T, String>) -> T {
    r.unwrap_or_else(|e| { eprintln!("error: {e}"); std::process::exit(1); })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostile_names_resolve_inside_the_target_directory() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().to_str().unwrap();
        for hostile in ["../../etc/passwd", "/etc/passwd", "..\\..\\boot.ini", "a/b/../../c", "..", "sub/"] {
            let dest = resolve_dest(Some(target), hostile);
            assert_eq!(dest.parent(), Some(dir.path()), "{hostile:?} → {}", dest.display());
            let leaf = dest.file_name().unwrap().to_str().unwrap();
            assert!(!leaf.contains('/') && !leaf.contains('\\') && leaf != "..", "{hostile:?} → {leaf}");
        }
        assert_eq!(resolve_dest(Some(target), "../../etc/passwd"), dir.path().join("passwd"));
        assert_eq!(resolve_dest(None, "../x/report.pdf"), PathBuf::from("./report.pdf"));
    }

    #[test]
    fn explicit_output_path_is_used_as_given() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.bin");
        assert_eq!(resolve_dest(Some(file.to_str().unwrap()), "../evil"), file);
    }

    #[test]
    fn remaining_time_and_size_formatting() {
        assert_eq!(format_remaining(59_000), "59s");
        assert_eq!(format_remaining(250_000), "4m10s");
        assert_eq!(format_remaining(86_340_000), "23h59m");
        assert_eq!(format_remaining(90_000_000), "1d01h");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1_048_576), "1.0 MiB");
    }
}
