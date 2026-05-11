//! copa-tray — Windows system tray client for the copa clipboard server.
//!
//! Right-click the tray icon to:
//!   "Copy to server"      — Windows clipboard → copa HTTP server
//!   "Paste from server"   — copa HTTP server → Windows clipboard
//!   "Upload to MQTT"      — Windows clipboard → MQTT broker (encrypted)
//!   "Download from MQTT"  — MQTT broker (retained) → Windows clipboard (decrypted)
//!
//! Configuration (highest priority first):
//!   CLI flags  >  env vars  >  config file
//!
//! Config file: %APPDATA%\copa\config.toml
//!
//!   [cli.remotes.myserver]
//!   url   = "https://copa.example.com"
//!   token = "abc123..."
//!
//!   [cli.mqtt_servers.mybroker]
//!   broker_url       = "wss://broker.emqx.io:8084/mqtt"
//!   topic            = "copa/clipboard/default"
//!   aes_key          = "YOUR_BASE64_OR_HEX_OR_BASE58_KEY"
//!   max_message_size = 65535   # optional
//!   client_id        = ""      # optional

#![windows_subsystem = "windows"]

fn main() {
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("copa-tray only runs on Windows");
        std::process::exit(1);
    }
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = win::run() {
            let msg = e.to_string();
            // Keep the file for full diagnostics.
            let path = std::env::temp_dir().join("copa-tray-error.txt");
            let _ = std::fs::write(&path, &msg);
            // Show a visible dialog — no console available with windows_subsystem = "windows".
            win::show_error("copa-tray — startup error", &msg);
        }
    }
}

// ── All Windows-specific code lives in this module ───────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use anyhow::anyhow;
    use clap::Parser;
    use copa::mqtt::{
        build_mqtt_options, default_max_message_size, mqtt_client_id, mqtt_decrypt, mqtt_encrypt,
        MqttServerCfg,
    };
    use rumqttc::{AsyncClient, Event, Packet, QoS};
    use serde::Deserialize;
    use std::collections::HashMap;
    use tray_icon::{
        TrayIconBuilder,
        menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    };
    use winit::event_loop::{EventLoopBuilder, ControlFlow};

    // ── Config types (same TOML layout as ~/.config/copa/config.toml) ────────

    #[derive(Deserialize, Default, Clone)]
    pub struct Remote {
        pub url: String,
        pub token: String,
        #[serde(default)]
        pub headers: HashMap<String, String>,
    }

    #[derive(Deserialize, Default)]
    struct CliConfig {
        #[serde(default)]
        remotes: HashMap<String, Remote>,
        default_remote: Option<String>,
        #[serde(default)]
        mqtt_servers: HashMap<String, MqttServerCfg>,
        default_mqtt_server: Option<String>,
    }

    #[derive(Deserialize, Default)]
    struct ConfigFile {
        #[serde(default)]
        cli: CliConfig,
    }

    // ── CLI args ──────────────────────────────────────────────────────────────

    #[derive(Parser)]
    #[command(name = "copa-tray", about = "copa Windows system tray client")]
    struct Args {
        // ── Copa HTTP server ──────────────────────────────────────────────────
        /// Server base URL (overrides config file)
        #[arg(long, env = "COPA_URL")]
        url: Option<String>,

        /// Bearer auth token (overrides config file)
        #[arg(long, env = "COPA_TOKEN")]
        token: Option<String>,

        /// Named remote from config file
        #[arg(long, env = "COPA_REMOTE")]
        remote: Option<String>,

        /// Path to config.toml  [default: %APPDATA%\copa\config.toml]
        #[arg(long, env = "COPA_CONFIG")]
        config: Option<String>,

        /// Extra request header as KEY=VAL (repeatable)
        #[arg(long = "header", value_name = "KEY=VAL")]
        headers: Vec<String>,

        // ── MQTT broker ───────────────────────────────────────────────────────
        /// Named MQTT server from [cli.mqtt_servers.<name>] in config
        #[arg(long, env = "COPA_MQTT_SERVER")]
        mqtt_server: Option<String>,

        /// MQTT broker URL: mqtt://, mqtts://, ws://, or wss://
        #[arg(long = "mqtt-broker", env = "COPA_MQTT_BROKER")]
        mqtt_broker: Option<String>,

        /// MQTT topic
        #[arg(long = "mqtt-topic", env = "COPA_MQTT_TOPIC")]
        mqtt_topic: Option<String>,

        /// AES-256 key: base64, 64-char hex, or base58
        #[arg(long = "mqtt-key", env = "COPA_MQTT_KEY")]
        mqtt_key: Option<String>,
    }

    // ── Config loading ────────────────────────────────────────────────────────

    fn load_config(path: Option<&str>) -> ConfigFile {
        let p = if let Some(p) = path {
            std::path::PathBuf::from(p)
        } else {
            dirs::config_dir()
                .unwrap_or_default()
                .join("copa")
                .join("config.toml")
        };
        std::fs::read_to_string(p)
            .ok()
            .and_then(|s| toml::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn resolve_remote(args: &Args) -> anyhow::Result<Remote> {
        // Fast path: both flags provided directly — no config file needed.
        if let (Some(url), Some(token)) = (&args.url, &args.token) {
            let mut headers = HashMap::new();
            for h in &args.headers {
                if let Some((k, v)) = h.split_once('=') {
                    headers.insert(k.to_string(), v.to_string());
                }
            }
            return Ok(Remote { url: url.clone(), token: token.clone(), headers });
        }

        let cfg = load_config(args.config.as_deref());

        let name = args.remote.as_deref()
            .or(cfg.cli.default_remote.as_deref())
            .or_else(|| cfg.cli.remotes.keys().next().map(|s| s.as_str()))
            .ok_or_else(|| anyhow!(
                "No server configured.\n\
                 Use --url + --token, or create %APPDATA%\\copa\\config.toml \
                 with a [cli.remotes.<name>] entry."
            ))?;

        let mut remote = cfg.cli.remotes.get(name).cloned().ok_or_else(|| {
            anyhow!("Remote '{}' not found in config file", name)
        })?;

        // CLI flags override individual fields of a named remote.
        if let Some(url) = &args.url   { remote.url   = url.clone(); }
        if let Some(tok) = &args.token { remote.token = tok.clone(); }
        for h in &args.headers {
            if let Some((k, v)) = h.split_once('=') {
                remote.headers.insert(k.to_string(), v.to_string());
            }
        }

        anyhow::ensure!(!remote.url.is_empty(),   "Remote '{}' has no url",   name);
        anyhow::ensure!(!remote.token.is_empty(), "Remote '{}' has no token", name);

        Ok(remote)
    }

    fn resolve_mqtt_server(args: &Args) -> Option<MqttServerCfg> {
        // Direct flags: --mqtt-broker + --mqtt-topic together create an ad-hoc server
        if let (Some(b), Some(t)) = (&args.mqtt_broker, &args.mqtt_topic) {
            return Some(MqttServerCfg {
                broker_url:       b.clone(),
                topic:            t.clone(),
                aes_key:          args.mqtt_key.clone(),
                max_message_size: default_max_message_size(),
                client_id:        None,
            });
        }

        let cfg = load_config(args.config.as_deref());

        let name = args.mqtt_server.as_deref()
            .or(cfg.cli.default_mqtt_server.as_deref())?;

        let mut srv = cfg.cli.mqtt_servers.get(name)?.clone();
        if let Some(k) = &args.mqtt_key { srv.aes_key = Some(k.clone()); }
        Some(srv)
    }

    // ── Error dialog (no console available) ──────────────────────────────────

    pub fn show_error(title: &str, body: &str) {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        #[allow(non_snake_case)]
        extern "system" {
            fn MessageBoxW(
                hwnd:       *mut std::ffi::c_void,
                lpText:     *const u16,
                lpCaption:  *const u16,
                uType:      u32,
            ) -> i32;
        }

        let to_wide = |s: &str| -> Vec<u16> {
            OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
        };

        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                to_wide(body).as_ptr(),
                to_wide(title).as_ptr(),
                0x10, // MB_ICONERROR
            );
        }
    }

    // ── Main Windows logic ────────────────────────────────────────────────────

    pub fn run() -> anyhow::Result<()> {
        let args     = Args::parse();
        let remote   = resolve_remote(&args)?;
        let mqtt_srv = resolve_mqtt_server(&args);

        // Tokio runtime for async MQTT operations.
        let tokio_rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;

        // Short display label: strip scheme and path, just the host.
        let host = remote.url
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or("copa");

        let menu               = Menu::new();
        let status_item        = MenuItem::new(format!("copa — {}", host), false, None);
        let copy_item          = MenuItem::new("Copy to server",      true,  None);
        let paste_item         = MenuItem::new("Paste from server",   true,  None);
        let mqtt_upload_item   = MenuItem::new("Upload to MQTT",      true,  None);
        let mqtt_download_item = MenuItem::new("Download from MQTT",  true,  None);
        let quit_item          = MenuItem::new("Quit",                true,  None);

        menu.append_items(&[
            &status_item,
            &PredefinedMenuItem::separator(),
            &copy_item,
            &paste_item,
            &PredefinedMenuItem::separator(),
            &mqtt_upload_item,
            &mqtt_download_item,
            &PredefinedMenuItem::separator(),
            &quit_item,
        ])?;

        let tray_icon = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("copa")
            .with_icon(load_icon())
            .build()?;

        let copy_id          = copy_item.id().clone();
        let paste_id         = paste_item.id().clone();
        let mqtt_upload_id   = mqtt_upload_item.id().clone();
        let mqtt_download_id = mqtt_download_item.id().clone();
        let quit_id          = quit_item.id().clone();

        let event_loop = EventLoopBuilder::<()>::new().build()?;
        event_loop.run(move |_event, target| {
            target.set_control_flow(ControlFlow::Wait);

            if let Ok(ev) = MenuEvent::receiver().try_recv() {
                if ev.id == copy_id {
                    do_copy(&remote, &tray_icon);
                } else if ev.id == paste_id {
                    do_paste(&remote, &tray_icon);
                } else if ev.id == mqtt_upload_id {
                    match &mqtt_srv {
                        Some(srv) => match tokio_rt.block_on(do_mqtt_upload(srv)) {
                            Ok(n)  => set_tip(&tray_icon, &format!("copa — MQTT sent {} bytes", n)),
                            Err(e) => set_tip(&tray_icon, &format!("copa — MQTT error: {e}")),
                        },
                        None => set_tip(&tray_icon,
                            "copa — no MQTT server configured (see --mqtt-broker / config.toml)"),
                    }
                } else if ev.id == mqtt_download_id {
                    match &mqtt_srv {
                        Some(srv) => match tokio_rt.block_on(do_mqtt_download(srv)) {
                            Ok(n)  => set_tip(&tray_icon, &format!("copa — MQTT got {} bytes", n)),
                            Err(e) => set_tip(&tray_icon, &format!("copa — MQTT error: {e}")),
                        },
                        None => set_tip(&tray_icon,
                            "copa — no MQTT server configured (see --mqtt-broker / config.toml)"),
                    }
                } else if ev.id == quit_id {
                    target.exit();
                }
            }
        })?;

        Ok(())
    }

    // ── Icon ──────────────────────────────────────────────────────────────────

    fn load_icon() -> tray_icon::Icon {
        const PNG: &[u8] = include_bytes!("../../assets/tray-icon.png");
        let img = image::load_from_memory(PNG)
            .expect("embedded tray icon is invalid")
            .into_rgba8();
        let (w, h) = img.dimensions();
        tray_icon::Icon::from_rgba(img.into_raw(), w, h)
            .expect("tray icon RGBA conversion failed")
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    /// Build a ureq request with auth + any extra headers from the remote config.
    fn build_req(method: &str, path: &str, remote: &Remote) -> ureq::Request {
        let url = format!(
            "{}/{}",
            remote.url.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let req = if method == "POST" { ureq::post(&url) } else { ureq::get(&url) };
        let req = req.set("Authorization", &format!("Bearer {}", remote.token));
        remote.headers.iter().fold(req, |r, (k, v)| r.set(k, v))
    }

    fn set_tip(tray: &tray_icon::TrayIcon, msg: &str) {
        let _ = tray.set_tooltip(Some(msg));
    }

    // ── Copy: Windows clipboard → server ─────────────────────────────────────

    fn do_copy(remote: &Remote, tray: &tray_icon::TrayIcon) {
        match copy_impl(remote) {
            Ok(n)  => set_tip(tray, &format!("copa — sent {} chars", n)),
            Err(e) => set_tip(tray, &format!("copa — error: {}", e)),
        }
    }

    fn copy_impl(remote: &Remote) -> anyhow::Result<usize> {
        let mut cb = arboard::Clipboard::new()?;
        let text   = cb.get_text()?;
        let len    = text.len();
        build_req("POST", "/api/clipboard", remote)
            .send_string(&text)
            .map_err(|e| anyhow!("{}", e))?;
        Ok(len)
    }

    // ── Paste: server → Windows clipboard ────────────────────────────────────

    fn do_paste(remote: &Remote, tray: &tray_icon::TrayIcon) {
        match paste_impl(remote) {
            Ok(n)  => set_tip(tray, &format!("copa — got {} chars", n)),
            Err(e) => set_tip(tray, &format!("copa — error: {}", e)),
        }
    }

    fn paste_impl(remote: &Remote) -> anyhow::Result<usize> {
        let content = build_req("GET", "/api/clipboard", remote)
            .call()
            .map_err(|e| anyhow!("{}", e))?
            .into_string()?;
        let len = content.len();
        arboard::Clipboard::new()?.set_text(content)?;
        Ok(len)
    }

    // ── MQTT: Windows clipboard → broker (upload) ─────────────────────────────

    async fn do_mqtt_upload(srv: &MqttServerCfg) -> anyhow::Result<usize> {
        // Get clipboard text before entering async context
        let text = arboard::Clipboard::new()?.get_text()?;
        let len  = text.len();

        let payload = match &srv.aes_key {
            Some(key) => mqtt_encrypt(&text, key).map_err(|e| anyhow!("{e}"))?,
            None      => text,
        };

        if payload.len() > srv.max_message_size {
            return Err(anyhow!(
                "payload too large ({} > {} bytes)",
                payload.len(), srv.max_message_size
            ));
        }

        let cid  = mqtt_client_id(&srv.client_id);
        let opts = build_mqtt_options(&srv.broker_url, &cid).map_err(|e| anyhow!("{e}"))?;
        let (client, mut evloop) = AsyncClient::new(opts, 16);

        tokio::time::timeout(
            std::time::Duration::from_secs(20),
            async move {
                let mut published = false;
                loop {
                    match evloop.poll().await {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            client
                                .publish(&srv.topic, QoS::AtLeastOnce, true, payload.as_bytes())
                                .await
                                .map_err(|e| anyhow!("publish: {e}"))?;
                            published = true;
                        }
                        Ok(Event::Incoming(Packet::PubAck(_))) if published => {
                            client.disconnect().await.ok();
                            return Ok::<usize, anyhow::Error>(len);
                        }
                        Ok(_) => {}
                        Err(e) => return Err(anyhow!("MQTT: {e}")),
                    }
                }
            },
        )
        .await
        .map_err(|_| anyhow!("MQTT upload timed out after 20s"))
        .and_then(|r| r)
    }

    // ── MQTT: broker (retained) → Windows clipboard (download) ───────────────

    async fn do_mqtt_download(srv: &MqttServerCfg) -> anyhow::Result<usize> {
        let cid  = mqtt_client_id(&srv.client_id);
        let opts = build_mqtt_options(&srv.broker_url, &cid).map_err(|e| anyhow!("{e}"))?;
        let (client, mut evloop) = AsyncClient::new(opts, 16);

        let text = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            async move {
                loop {
                    match evloop.poll().await {
                        Ok(Event::Incoming(Packet::ConnAck(_))) => {
                            client
                                .subscribe(&srv.topic, QoS::AtLeastOnce)
                                .await
                                .map_err(|e| anyhow!("subscribe: {e}"))?;
                        }
                        Ok(Event::Incoming(Packet::Publish(p))) => {
                            let raw = String::from_utf8_lossy(&p.payload).into_owned();
                            let text = if let Some(ref key) = srv.aes_key {
                                mqtt_decrypt(&raw, key).map_err(|e| anyhow!("{e}"))?
                            } else {
                                raw
                            };
                            client.disconnect().await.ok();
                            return Ok::<String, anyhow::Error>(text);
                        }
                        Ok(_) => {}
                        Err(e) => return Err(anyhow!("MQTT: {e}")),
                    }
                }
            },
        )
        .await
        .map_err(|_| anyhow!("MQTT download timed out after 20s (no retained message?)"))?
        .and_then(|t| Ok(t))?;

        let len = text.len();
        // Set clipboard after all async work is done
        arboard::Clipboard::new()?.set_text(text)?;
        Ok(len)
    }
}
