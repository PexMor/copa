/// Shared server state: namespaces, their histories and the object store
use super::config::{NamespaceConfig, ServerConfig, DEFAULT_SIZE_LIMIT};
use crate::history::{History, Item, Removed};
use super::issuers;
use super::pairing::Pairing;
use super::token::{default_state_dir, TokenService, SECRET_ENV};
use crate::storage::Storage;
use crate::{config_path, gen_token};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
};
use tokio::sync::broadcast;

const BROADCAST_CAP: usize = 64;
/// Failed object deletions waiting for a retry. Beyond this the periodic
/// reconcile of the key prefix picks up what was dropped.
const DELETE_QUEUE_CAP: usize = 10_000;

/// How long an event-stream ticket can be redeemed.
pub const TICKET_TTL_MS: u64 = 30_000;
/// Upper bound on outstanding tickets (expired ones are purged on every issue).
const TICKET_CAP: usize = 10_000;

/// A single-use credential for `/ws/events` (browsers cannot set headers on a
/// WebSocket upgrade, and a long-lived token must not go into a URL).
pub struct Ticket {
    pub ns:              String,
    pub expires_ms:      u64,
    /// When the credential that obtained the ticket stops being valid.
    pub cred_expires_ms: Option<u64>,
}

/// Unix-milliseconds clock; replaceable in tests.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct NamespaceState {
    pub name:        String,
    history:         Mutex<History>,
    pub size_limit:  usize,
    pub read_token:  Option<String>,
    pub write_token: Option<String>,
    pub rw_token:    Option<String>,
    /// File items available (storage configured and not opted out).
    pub files:       bool,
    /// Text content, for `/ws` subscribers.
    pub tx:          broadcast::Sender<Vec<u8>>,
    /// JSON event frames, for `/ws/events` subscribers.
    pub events:      broadcast::Sender<String>,
}

impl NamespaceState {
    pub fn new(name: &str, cfg: &NamespaceConfig, storage_configured: bool) -> Result<Self, String> {
        let (tx, _) = broadcast::channel(BROADCAST_CAP);
        let (events, _) = broadcast::channel(BROADCAST_CAP);
        Ok(Self {
            name:        name.to_owned(),
            history:     Mutex::new(History::new(cfg.limits(name)?)),
            size_limit:  cfg.size_limit.unwrap_or(DEFAULT_SIZE_LIMIT),
            read_token:  cfg.read_token.clone(),
            write_token: cfg.write_token.clone(),
            rw_token:    cfg.rw_token.clone(),
            files:       storage_configured && cfg.files.unwrap_or(true),
            tx,
            events,
        })
    }

    /// The lock is never held across an await point.
    pub fn history(&self) -> MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct AppState {
    pub namespaces:      HashMap<String, Arc<NamespaceState>>,
    pub storage:         Option<Arc<Storage>>,
    pub allowed_origins: Option<Vec<String>>,
    /// Device tokens (pairing); `None` unless `[server.pairing]` is enabled.
    pub tokens:          Option<Arc<TokenService>>,
    /// Pairing windows and limits; `Some` exactly when `tokens` is.
    pub pairing:         Option<Pairing>,
    /// Trusted token issuers (JWT); `None` unless `[server.auth.issuers.*]` is configured.
    pub issuers:         Option<issuers::IssuerSet>,
    clock:               Clock,
    tickets:             Mutex<HashMap<String, Ticket>>,
    delete_queue:        Mutex<Vec<String>>,
}

impl AppState {
    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Mint a single-use event-stream ticket for `ns`; returns it with its expiry (unix ms).
    pub fn issue_ticket(&self, ns: &str, cred_expires_ms: Option<u64>) -> Option<(String, u64)> {
        let now = self.now();
        let mut tickets = self.tickets.lock().unwrap_or_else(|e| e.into_inner());
        tickets.retain(|_, t| t.expires_ms > now);
        if tickets.len() >= TICKET_CAP {
            return None;
        }
        let bytes: [u8; 24] = rand::random();
        let id = hex::encode(bytes);
        let expires_ms = now + TICKET_TTL_MS;
        tickets.insert(id.clone(), Ticket { ns: ns.to_owned(), expires_ms, cred_expires_ms });
        Some((id, expires_ms))
    }

    /// Consume a ticket. It is removed whether or not it is valid for `ns`, so a
    /// ticket presented for the wrong namespace is spent.
    pub fn redeem_ticket(&self, id: &str, ns: &str) -> Option<Ticket> {
        let t = self.tickets.lock().unwrap_or_else(|e| e.into_inner()).remove(id)?;
        (t.ns == ns && self.now() < t.expires_ms).then_some(t)
    }

    /// Announce a new (or refreshed) item on the event stream.
    pub fn publish_added(&self, ns: &NamespaceState, item: &Item) {
        let _ = ns.events.send(json!({ "type": "item_added", "item": item.meta_json() }).to_string());
    }

    /// Announce removed items; returns the object keys that must be deleted.
    pub fn publish_removed(&self, ns: &NamespaceState, removed: Vec<Removed>) -> Vec<String> {
        let mut keys = Vec::new();
        for r in removed {
            let _ = ns.events.send(
                json!({ "type": "item_removed", "id": r.id, "reason": r.reason.as_str() }).to_string(),
            );
            eprintln!("history ns={} removed id={} reason={}", ns.name, r.id, r.reason.as_str());
            keys.extend(r.key);
        }
        keys
    }

    /// Announce removed items and delete their objects in the background.
    pub fn apply_removed(self: &Arc<Self>, ns: &NamespaceState, removed: Vec<Removed>) {
        let keys = self.publish_removed(ns, removed);
        if !keys.is_empty() {
            let state = self.clone();
            tokio::spawn(async move { state.delete_objects(keys).await });
        }
    }

    /// Store a text item and notify `/ws` and `/ws/events` subscribers.
    pub fn push_text(self: &Arc<Self>, ns: &NamespaceState, data: Vec<u8>, ttl_secs: Option<u64>) {
        let added = ns.history().add_text(gen_token(), data.clone(), ttl_secs, self.now());
        let _ = ns.tx.send(data);
        self.publish_added(ns, &added.item);
        self.apply_removed(ns, added.removed);
    }

    /// Delete objects from the store; failures are queued for retry.
    pub async fn delete_objects(&self, keys: Vec<String>) {
        let Some(storage) = self.storage.clone() else { return };
        for key in keys {
            let s = storage.clone();
            let k = key.clone();
            let result = tokio::task::spawn_blocking(move || s.delete(&k))
                .await
                .unwrap_or_else(|e| Err(format!("delete task failed: {e}")));
            if let Err(e) = result {
                eprintln!("warning: object delete failed, will retry: {e}");
                let mut q = self.delete_queue.lock().unwrap_or_else(|e| e.into_inner());
                if q.len() < DELETE_QUEUE_CAP {
                    q.push(key);
                }
            }
        }
    }

    pub fn take_delete_queue(&self) -> Vec<String> {
        std::mem::take(&mut *self.delete_queue.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

pub fn build_app_state(
    srv: &ServerConfig,
    storage: Option<Arc<Storage>>,
    clock: Clock,
    port: u16,
    bind: &str,
) -> Result<Arc<AppState>, String> {
    let mut namespaces: HashMap<String, Arc<NamespaceState>> = HashMap::new();
    let has_storage = storage.is_some();

    if !srv.namespaces.is_empty() {
        for (name, cfg) in &srv.namespaces {
            if cfg.read_token.is_none() && cfg.write_token.is_none() && cfg.rw_token.is_none() {
                eprintln!("warning: namespace '{name}' has no tokens — it will be inaccessible");
            }
            namespaces.insert(name.clone(), Arc::new(NamespaceState::new(name, cfg, has_storage)?));
        }
    } else {
        // Legacy path: promote server.token → default namespace rw_token
        let rw = srv.token.clone().unwrap_or_else(|| {
            let t = gen_token();
            eprintln!("token: {t}");
            eprintln!("hint: save to {} under [server.namespaces.default]", config_path().display());
            t
        });
        let cfg = NamespaceConfig { rw_token: Some(rw.clone()), ..Default::default() };
        namespaces.insert("default".to_owned(), Arc::new(NamespaceState::new("default", &cfg, has_storage)?));
        eprintln!("URL:  http://{}:{}/#token={rw}", bind, port);
    }

    // Always ensure "default" exists
    if !namespaces.contains_key("default") {
        let t = gen_token();
        eprintln!("auto-generated default namespace token: {t}");
        let cfg = NamespaceConfig { rw_token: Some(t), ..Default::default() };
        namespaces.insert("default".to_owned(), Arc::new(NamespaceState::new("default", &cfg, has_storage)?));
    }

    // Validate trusted issuers at startup so a misconfiguration stops the server with a clear message.
    let issuer_set = match &srv.auth {
        Some(auth) if !auth.issuers.is_empty() => {
            let names: std::collections::HashSet<String> = namespaces.keys().cloned().collect();
            Some(issuers::IssuerSet::new(issuers::validate(&auth.issuers, &names)?))
        }
        _ => None,
    };

    let pairing = srv.pairing.clone().filter(|p| p.enabled).map(Pairing::new);
    let tokens = match &srv.pairing {
        Some(p) if p.enabled => {
            p.validate()?;
            let dir = p.state_dir.clone().unwrap_or_else(default_state_dir);
            Some(Arc::new(TokenService::open(Some(&dir), std::env::var(SECRET_ENV).ok())?))
        }
        _ => None,
    };

    Ok(Arc::new(AppState {
        namespaces,
        storage,
        allowed_origins: srv.allowed_origins.clone(),
        tokens,
        pairing,
        issuers: issuer_set,
        clock,
        tickets: Mutex::new(HashMap::new()),
        delete_queue: Mutex::new(Vec::new()),
    }))
}
