/// Per-namespace clipboard history: bounded, expiring list of text and file items.
///
/// Pure data structure — no I/O and no clock of its own. Every method takes
/// `now` (unix milliseconds) and returns the *effects* (removed items, object
/// keys to delete) for the caller to broadcast and act on.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

pub const DEFAULT_HISTORY_LIMIT: usize = 20;
pub const DEFAULT_ITEM_TTL_SECS: u64 = 86_400;
pub const DEFAULT_MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;
pub const DEFAULT_FILE_QUOTA_BYTES: u64 = 500 * 1024 * 1024;
pub const PREVIEW_CHARS: usize = 200;
/// Upper bound on concurrently pending (requested, not completed) uploads.
pub const MAX_PENDING_UPLOADS: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum ItemKind {
    Text(Vec<u8>),
    File { key: String, name: String, content_type: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id:         String,
    pub kind:       ItemKind,
    pub size:       u64,
    pub created_at: u64,
    pub expires_at: u64,
}

impl Item {
    pub fn is_live(&self, now: u64) -> bool {
        self.expires_at > now
    }

    pub fn is_text(&self) -> bool {
        matches!(self.kind, ItemKind::Text(_))
    }

    fn object_key(&self) -> Option<String> {
        match &self.kind {
            ItemKind::File { key, .. } => Some(key.clone()),
            ItemKind::Text(_) => None,
        }
    }

    /// Listing metadata: never contains full text content or any URL.
    pub fn meta_json(&self) -> Value {
        let mut v = json!({
            "id":         self.id,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "size":       self.size,
        });
        match &self.kind {
            ItemKind::Text(data) => {
                let preview: String = String::from_utf8_lossy(data).chars().take(PREVIEW_CHARS).collect();
                v["kind"] = json!("text");
                v["preview"] = json!(preview);
            }
            ItemKind::File { name, content_type, .. } => {
                v["kind"] = json!("file");
                v["name"] = json!(name);
                v["content_type"] = json!(content_type);
            }
        }
        v
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoveReason {
    Expired,
    Deleted,
    Evicted,
}

impl RemoveReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoveReason::Expired => "expired",
            RemoveReason::Deleted => "deleted",
            RemoveReason::Evicted => "evicted",
        }
    }
}

/// An item that left the history. `key` is set for file items: the caller
/// must delete that object from the store.
#[derive(Clone, Debug, PartialEq)]
pub struct Removed {
    pub id:     String,
    pub reason: RemoveReason,
    pub key:    Option<String>,
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub history_limit:    usize,
    pub item_ttl_ms:      u64,
    pub max_file_size:    u64,
    pub file_quota_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            history_limit:    DEFAULT_HISTORY_LIMIT,
            item_ttl_ms:      DEFAULT_ITEM_TTL_SECS * 1000,
            max_file_size:    DEFAULT_MAX_FILE_SIZE,
            file_quota_bytes: DEFAULT_FILE_QUOTA_BYTES,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpload {
    pub id:           String,
    pub key:          String,
    pub name:         String,
    pub content_type: String,
    pub size:         u64,
    /// Item lifetime to apply once the upload is completed.
    pub ttl_ms:       u64,
    /// After this instant the pending upload is discarded.
    pub deadline:     u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadError {
    Empty,
    TooLarge,
    QuotaExceeded,
    TooManyPending,
}

/// Result of adding an item.
#[derive(Clone, Debug)]
pub struct Added {
    pub item:      Item,
    /// True when an identical newest text item was refreshed instead.
    pub refreshed: bool,
    pub removed:   Vec<Removed>,
}

#[derive(Clone, Debug, Default)]
pub struct Reaped {
    pub removed:     Vec<Removed>,
    /// Keys of abandoned uploads (the object may or may not exist).
    pub orphan_keys: Vec<String>,
}

pub struct History {
    limits:  Limits,
    /// Newest first.
    items:   VecDeque<Item>,
    pending: HashMap<String, PendingUpload>,
}

impl History {
    pub fn new(limits: Limits) -> Self {
        Self { limits, items: VecDeque::new(), pending: HashMap::new() }
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Effective lifetime: the namespace TTL, or a shorter client-requested one.
    fn ttl_ms(&self, requested_secs: Option<u64>) -> u64 {
        match requested_secs {
            Some(s) => s.max(1).saturating_mul(1000).min(self.limits.item_ttl_ms),
            None => self.limits.item_ttl_ms,
        }
    }

    fn drop_expired(&mut self, now: u64) -> Vec<Removed> {
        let mut removed = Vec::new();
        self.items.retain(|i| {
            if i.is_live(now) {
                return true;
            }
            removed.push(Removed { id: i.id.clone(), reason: RemoveReason::Expired, key: i.object_key() });
            false
        });
        removed
    }

    fn push(&mut self, item: Item, now: u64) -> Vec<Removed> {
        let mut removed = self.drop_expired(now);
        self.items.push_front(item);
        while self.items.len() > self.limits.history_limit {
            if let Some(old) = self.items.pop_back() {
                removed.push(Removed { key: old.object_key(), id: old.id, reason: RemoveReason::Evicted });
            }
        }
        removed
    }

    /// Add a text item. Text identical to the newest live text item refreshes
    /// that item instead of creating a duplicate.
    pub fn add_text(&mut self, id: String, data: Vec<u8>, ttl_secs: Option<u64>, now: u64) -> Added {
        let expires_at = now.saturating_add(self.ttl_ms(ttl_secs));
        let newest_text = self.items.iter().position(|i| i.is_text() && i.is_live(now));
        if let Some(pos) = newest_text {
            if matches!(&self.items[pos].kind, ItemKind::Text(d) if *d == data) {
                let mut item = self.items.remove(pos).expect("position is valid");
                item.created_at = now;
                item.expires_at = expires_at;
                self.items.push_front(item.clone());
                return Added { item, refreshed: true, removed: Vec::new() };
            }
        }
        let item = Item { id, size: data.len() as u64, kind: ItemKind::Text(data), created_at: now, expires_at };
        let removed = self.push(item.clone(), now);
        Added { item, refreshed: false, removed }
    }

    /// Content of the newest unexpired text item.
    pub fn latest_text(&self, now: u64) -> Option<&[u8]> {
        self.items.iter().filter(|i| i.is_live(now)).find_map(|i| match &i.kind {
            ItemKind::Text(d) => Some(d.as_slice()),
            _ => None,
        })
    }

    /// Unexpired items, newest first.
    pub fn list(&self, now: u64) -> Vec<&Item> {
        self.items.iter().filter(|i| i.is_live(now)).collect()
    }

    pub fn get(&self, id: &str, now: u64) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id && i.is_live(now))
    }

    /// Explicitly delete one item. Expired items count as absent.
    pub fn remove(&mut self, id: &str, now: u64) -> Option<Removed> {
        let pos = self.items.iter().position(|i| i.id == id && i.is_live(now))?;
        let item = self.items.remove(pos)?;
        Some(Removed { key: item.object_key(), id: item.id, reason: RemoveReason::Deleted })
    }

    /// Delete every item of the namespace.
    pub fn clear(&mut self) -> Vec<Removed> {
        self.items
            .drain(..)
            .map(|i| Removed { key: i.object_key(), id: i.id, reason: RemoveReason::Deleted })
            .collect()
    }

    /// Drop expired items and overdue pending uploads.
    pub fn reap(&mut self, now: u64) -> Reaped {
        let removed = self.drop_expired(now);
        let mut orphan_keys = Vec::new();
        self.pending.retain(|_, p| {
            if p.deadline > now {
                return true;
            }
            orphan_keys.push(p.key.clone());
            false
        });
        Reaped { removed, orphan_keys }
    }

    /// Bytes of stored (unexpired) files plus pending uploads.
    pub fn file_bytes(&self, now: u64) -> u64 {
        let stored: u64 = self.items.iter().filter(|i| i.is_live(now) && !i.is_text()).map(|i| i.size).sum();
        let pending: u64 = self.pending.values().filter(|p| p.deadline > now).map(|p| p.size).sum();
        stored + pending
    }

    /// Register an upload that the client is about to perform.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_upload(
        &mut self,
        id: String,
        key: String,
        name: String,
        content_type: String,
        size: u64,
        ttl_secs: Option<u64>,
        deadline: u64,
        now: u64,
    ) -> Result<PendingUpload, UploadError> {
        if size == 0 {
            return Err(UploadError::Empty);
        }
        if size > self.limits.max_file_size {
            return Err(UploadError::TooLarge);
        }
        if self.file_bytes(now).saturating_add(size) > self.limits.file_quota_bytes {
            return Err(UploadError::QuotaExceeded);
        }
        if self.pending.values().filter(|p| p.deadline > now).count() >= MAX_PENDING_UPLOADS {
            return Err(UploadError::TooManyPending);
        }
        let p = PendingUpload { id: id.clone(), key, name, content_type, size, ttl_ms: self.ttl_ms(ttl_secs), deadline };
        self.pending.insert(id, p.clone());
        Ok(p)
    }

    /// A pending upload that has not passed its deadline.
    pub fn pending(&self, id: &str, now: u64) -> Option<&PendingUpload> {
        self.pending.get(id).filter(|p| p.deadline > now)
    }

    /// Forget a pending upload (failed verification). Returns its object key.
    pub fn abort_upload(&mut self, id: &str) -> Option<String> {
        self.pending.remove(id).map(|p| p.key)
    }

    /// Turn a verified pending upload into a visible file item.
    pub fn commit_upload(&mut self, id: &str, now: u64) -> Option<Added> {
        let p = self.pending.remove(id)?;
        let item = Item {
            id:         p.id,
            kind:       ItemKind::File { key: p.key, name: p.name, content_type: p.content_type },
            size:       p.size,
            created_at: now,
            expires_at: now.saturating_add(p.ttl_ms),
        };
        let removed = self.push(item.clone(), now);
        Some(Added { item, refreshed: false, removed })
    }

    /// Object keys that must exist: file items and pending uploads.
    pub fn referenced_keys(&self) -> Vec<String> {
        self.items
            .iter()
            .filter_map(Item::object_key)
            .chain(self.pending.values().map(|p| p.key.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(history_limit: usize, ttl_secs: u64) -> Limits {
        Limits { history_limit, item_ttl_ms: ttl_secs * 1000, max_file_size: 1000, file_quota_bytes: 2500 }
    }

    fn text(h: &mut History, id: &str, s: &str, now: u64) -> Added {
        h.add_text(id.into(), s.as_bytes().to_vec(), None, now)
    }

    fn upload(h: &mut History, id: &str, size: u64, now: u64) -> Result<PendingUpload, UploadError> {
        h.begin_upload(id.into(), format!("k/{id}"), "f.bin".into(), "application/pdf".into(), size, None, now + 360_000, now)
    }

    #[test]
    fn push_creates_new_item_and_keeps_earlier_ones() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "a", "one", 0);
        let added = text(&mut h, "b", "two", 10);
        assert!(!added.refreshed);
        let ids: Vec<_> = h.list(20).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(h.latest_text(20), Some("two".as_bytes()));
        assert!(h.get("a", 20).is_some());
    }

    #[test]
    fn oldest_item_is_evicted_at_the_limit() {
        let mut h = History::new(limits(3, 3600));
        for (n, id) in ["a", "b", "c"].iter().enumerate() {
            text(&mut h, id, id, n as u64);
        }
        let added = text(&mut h, "d", "d", 10);
        assert_eq!(added.removed, vec![Removed { id: "a".into(), reason: RemoveReason::Evicted, key: None }]);
        assert_eq!(h.list(11).len(), 3);
    }

    #[test]
    fn evicted_file_item_reports_its_object_key() {
        let mut h = History::new(limits(1, 3600));
        upload(&mut h, "f", 10, 0).unwrap();
        h.commit_upload("f", 1).unwrap();
        let added = text(&mut h, "t", "x", 2);
        assert_eq!(added.removed, vec![Removed { id: "f".into(), reason: RemoveReason::Evicted, key: Some("k/f".into()) }]);
    }

    #[test]
    fn identical_text_refreshes_instead_of_duplicating() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "a", "same", 0);
        let added = text(&mut h, "b", "same", 5000);
        assert!(added.refreshed);
        assert_eq!(added.item.id, "a");
        assert_eq!(added.item.created_at, 5000);
        assert_eq!(added.item.expires_at, 5000 + 3_600_000);
        assert_eq!(h.list(5001).len(), 1);
    }

    #[test]
    fn refreshed_text_moves_ahead_of_a_newer_file() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "a", "same", 0);
        upload(&mut h, "f", 10, 1).unwrap();
        h.commit_upload("f", 2).unwrap();
        text(&mut h, "b", "same", 3);
        let ids: Vec<_> = h.list(4).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["a", "f"]);
    }

    #[test]
    fn default_ttl_is_applied() {
        let mut h = History::new(limits(5, 3600));
        let added = text(&mut h, "a", "x", 1000);
        assert_eq!(added.item.expires_at, 1000 + 3_600_000);
    }

    #[test]
    fn shorter_requested_ttl_is_honoured() {
        let mut h = History::new(limits(5, 3600));
        let added = h.add_text("a".into(), b"x".to_vec(), Some(60), 1000);
        assert_eq!(added.item.expires_at, 1000 + 60_000);
    }

    #[test]
    fn longer_requested_ttl_is_clamped() {
        let mut h = History::new(limits(5, 3600));
        let added = h.add_text("a".into(), b"x".to_vec(), Some(999_999), 1000);
        assert_eq!(added.item.expires_at, 1000 + 3_600_000);
    }

    #[test]
    fn expired_items_are_not_listed_or_retrievable_before_reaping() {
        let mut h = History::new(limits(5, 10));
        text(&mut h, "a", "x", 0);
        assert!(h.get("a", 9_999).is_some());
        assert!(h.get("a", 10_000).is_none());
        assert!(h.list(10_000).is_empty());
        assert_eq!(h.latest_text(10_000), None);
        assert!(h.remove("a", 10_000).is_none());
    }

    #[test]
    fn latest_text_falls_back_to_older_unexpired_text() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "old", "old", 0);
        h.add_text("new".into(), b"new".to_vec(), Some(1), 10);
        assert_eq!(h.latest_text(500), Some("new".as_bytes()));
        assert_eq!(h.latest_text(2000), Some("old".as_bytes()));
    }

    #[test]
    fn reap_removes_expired_items_with_reason_and_key() {
        let mut h = History::new(limits(5, 10));
        text(&mut h, "t", "x", 0);
        upload(&mut h, "f", 10, 0).unwrap();
        h.commit_upload("f", 0).unwrap();
        let reaped = h.reap(10_000);
        assert_eq!(reaped.removed.len(), 2);
        assert!(reaped.removed.iter().all(|r| r.reason == RemoveReason::Expired));
        assert!(reaped.removed.iter().any(|r| r.key.as_deref() == Some("k/f")));
        assert!(h.referenced_keys().is_empty());
    }

    #[test]
    fn file_item_does_not_change_latest_text() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "t", "hello", 0);
        upload(&mut h, "f", 10, 1).unwrap();
        h.commit_upload("f", 2).unwrap();
        assert_eq!(h.latest_text(3), Some("hello".as_bytes()));
        assert_eq!(h.list(3)[0].id, "f");
    }

    #[test]
    fn remove_and_clear_report_deleted() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "t", "x", 0);
        upload(&mut h, "f", 10, 0).unwrap();
        h.commit_upload("f", 0).unwrap();
        assert_eq!(h.remove("t", 1), Some(Removed { id: "t".into(), reason: RemoveReason::Deleted, key: None }));
        assert_eq!(h.clear(), vec![Removed { id: "f".into(), reason: RemoveReason::Deleted, key: Some("k/f".into()) }]);
        assert!(h.list(1).is_empty());
    }

    #[test]
    fn preview_is_bounded_and_listing_has_no_content() {
        let mut h = History::new(limits(5, 3600));
        text(&mut h, "t", &"é".repeat(500), 0);
        let meta = h.list(1)[0].meta_json();
        assert_eq!(meta["preview"].as_str().unwrap().chars().count(), PREVIEW_CHARS);
        assert_eq!(meta["kind"], "text");
        assert_eq!(meta["size"], 1000);
    }

    #[test]
    fn upload_size_limits() {
        let mut h = History::new(limits(5, 3600));
        assert_eq!(upload(&mut h, "z", 0, 0), Err(UploadError::Empty));
        assert_eq!(upload(&mut h, "big", 1001, 0), Err(UploadError::TooLarge));
        assert!(upload(&mut h, "ok", 1000, 0).is_ok());
    }

    #[test]
    fn quota_counts_stored_and_pending_bytes() {
        let mut h = History::new(limits(5, 3600));
        upload(&mut h, "a", 1000, 0).unwrap();
        h.commit_upload("a", 0).unwrap();
        upload(&mut h, "b", 1000, 0).unwrap(); // pending
        assert_eq!(h.file_bytes(1), 2000);
        assert_eq!(upload(&mut h, "c", 501, 1), Err(UploadError::QuotaExceeded));
        assert!(upload(&mut h, "d", 500, 1).is_ok());
    }

    #[test]
    fn overdue_pending_upload_frees_quota_and_reports_orphan() {
        let mut h = History::new(limits(5, 3600));
        h.begin_upload("p".into(), "k/p".into(), "f".into(), "x".into(), 1000, None, 360_000, 0).unwrap();
        assert!(h.pending("p", 359_999).is_some());
        assert!(h.pending("p", 360_000).is_none());
        assert_eq!(h.file_bytes(360_000), 0);
        let reaped = h.reap(360_000);
        assert_eq!(reaped.orphan_keys, vec!["k/p".to_string()]);
        assert!(h.commit_upload("p", 360_001).is_none());
    }

    #[test]
    fn pending_upload_is_invisible_until_committed() {
        let mut h = History::new(limits(5, 3600));
        upload(&mut h, "f", 10, 0).unwrap();
        assert!(h.list(1).is_empty());
        assert_eq!(h.referenced_keys(), vec!["k/f".to_string()]);
        let added = h.commit_upload("f", 5).unwrap();
        assert_eq!(added.item.expires_at, 5 + 3_600_000);
        let meta = h.list(6)[0].meta_json();
        assert_eq!(meta["kind"], "file");
        assert_eq!(meta["name"], "f.bin");
        assert_eq!(meta["content_type"], "application/pdf");
        assert!(meta.get("key").is_none());
    }

    #[test]
    fn pending_upload_count_is_bounded() {
        let mut h = History::new(Limits { file_quota_bytes: u64::MAX, ..limits(5, 3600) });
        for n in 0..MAX_PENDING_UPLOADS {
            upload(&mut h, &format!("p{n}"), 1, 0).unwrap();
        }
        assert_eq!(upload(&mut h, "more", 1, 0), Err(UploadError::TooManyPending));
    }
}
