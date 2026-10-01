/// Background cleanup: expire items, retry object deletions, sweep orphans
use super::state::AppState;
use std::{collections::HashSet, sync::Arc, time::Duration};

pub const REAP_INTERVAL: Duration = Duration::from_secs(30);
/// Reconcile the key prefix every this many reaper ticks (15 minutes).
const RECONCILE_EVERY_TICKS: u32 = 30;

/// Remove expired items and overdue pending uploads in every namespace,
/// announce them, and delete their objects (plus earlier failed deletions).
pub async fn reap_once(state: &Arc<AppState>) {
    let now = state.now();
    let mut keys = state.take_delete_queue();
    for ns in state.namespaces.values() {
        let reaped = ns.history().reap(now);
        keys.extend(state.publish_removed(ns, reaped.removed));
        keys.extend(reaped.orphan_keys);
    }
    state.delete_objects(keys).await;
}

/// Delete every object under the key prefix that no item or pending upload
/// refers to. Returns the number of orphans found.
pub async fn reconcile(state: &Arc<AppState>) -> Result<usize, String> {
    let Some(storage) = state.storage.clone() else { return Ok(0) };
    let s = storage.clone();
    let listed = tokio::task::spawn_blocking(move || s.list_keys())
        .await
        .map_err(|e| format!("list task failed: {e}"))??;

    // Collected after listing: an upload is registered before its URL is
    // issued, so any object that exists by now is already referenced.
    let referenced: HashSet<String> =
        state.namespaces.values().flat_map(|ns| ns.history().referenced_keys()).collect();
    let orphans: Vec<String> = listed.into_iter().filter(|k| !referenced.contains(k)).collect();
    let count = orphans.len();
    if count > 0 {
        eprintln!("storage: removing {count} orphaned object(s) under '{}'", storage.key_prefix());
        state.delete_objects(orphans).await;
    }
    Ok(count)
}

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        if let Err(e) = reconcile(&state).await {
            eprintln!("warning: storage reconcile failed: {e}");
        }
        let mut tick = tokio::time::interval(REAP_INTERVAL);
        tick.tick().await; // first tick fires immediately
        let mut n: u32 = 0;
        loop {
            tick.tick().await;
            reap_once(&state).await;
            n += 1;
            if n % RECONCILE_EVERY_TICKS == 0 {
                if let Err(e) = reconcile(&state).await {
                    eprintln!("warning: storage reconcile failed: {e}");
                }
            }
        }
    });
}
