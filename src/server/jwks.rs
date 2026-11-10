/// Cached JWKS of one trusted issuer.
///
/// * keys are fetched on first use, then refreshed when older than `ttl`;
/// * an unknown `kid` triggers a refresh, but at most one per `min_refresh`, so a
///   stream of bogus key ids cannot turn copasrv into a request amplifier;
/// * when a fetch fails the previously fetched keys stay in use (stale-on-failure);
/// * a cold cache makes concurrent first requests wait for the single in-flight fetch.
use jsonwebtoken::jwk::{Jwk, JwkSet};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub type FetchFn = Box<dyn Fn(&str) -> Result<JwkSet, String> + Send + Sync>;

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

struct Inner {
    keys:      Vec<Jwk>,
    fetched:   Option<Instant>,
    attempted: Option<Instant>,
}

pub struct Jwks {
    name:        String,
    url:         String,
    ttl:         Duration,
    min_refresh: Duration,
    fetch:       FetchFn,
    inner:       Mutex<Inner>,
    /// Held while a fetch is in flight.
    fetch_lock:  Mutex<()>,
}

/// Fetch over HTTP(S) with a hard timeout.
pub fn http_fetch(url: &str) -> Result<JwkSet, String> {
    let resp = ureq::get(url).timeout(FETCH_TIMEOUT).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        other => other.to_string(),
    })?;
    let set: JwkSet = resp.into_json().map_err(|e| format!("not a JWKS: {e}"))?;
    Ok(set)
}

/// Run blocking I/O without stalling the async runtime's worker.
fn blocking<T>(f: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(h) if h.runtime_flavor() == RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

impl Jwks {
    pub fn new(name: &str, url: &str, ttl: Duration, min_refresh: Duration, fetch: FetchFn) -> Self {
        Self {
            name: name.to_owned(),
            url: url.to_owned(),
            ttl,
            min_refresh,
            fetch,
            inner: Mutex::new(Inner { keys: Vec::new(), fetched: None, attempted: None }),
            fetch_lock: Mutex::new(()),
        }
    }

    pub fn over_http(name: &str, url: &str, ttl: Duration, min_refresh: Duration) -> Self {
        Self::new(name, url, ttl, min_refresh, Box::new(http_fetch))
    }

    fn lookup(keys: &[Jwk], kid: Option<&str>) -> Option<Jwk> {
        match kid {
            Some(kid) => keys.iter().find(|k| k.common.key_id.as_deref() == Some(kid)).cloned(),
            // Without a kid only an unambiguous key set can be used.
            None if keys.len() == 1 => keys.first().cloned(),
            None => None,
        }
    }

    /// (found, stale, never_fetched, may_fetch)
    fn peek(&self, kid: Option<&str>) -> (Option<Jwk>, bool, bool, bool) {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let stale = g.fetched.map_or(true, |t| t.elapsed() >= self.ttl);
        let may = g.attempted.map_or(true, |t| t.elapsed() >= self.min_refresh);
        (Self::lookup(&g.keys, kid), stale, g.fetched.is_none(), may)
    }

    /// The signing key for `kid`, refreshing the cache when allowed and needed.
    pub fn key(&self, kid: Option<&str>) -> Option<Jwk> {
        let (found, stale, never, may) = self.peek(kid);
        if found.is_some() && !stale {
            return found;
        }
        if !may && !never {
            return found; // rate limited: serve what we have (possibly stale, possibly nothing)
        }
        self.refresh(never);
        self.peek(kid).0
    }

    fn refresh(&self, wait: bool) {
        let guard = if wait {
            Some(self.fetch_lock.lock().unwrap_or_else(|e| e.into_inner()))
        } else {
            self.fetch_lock.try_lock().ok()
        };
        let Some(_guard) = guard else { return };
        {
            // Re-check under the fetch lock: another thread may just have fetched.
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !g.attempted.map_or(true, |t| t.elapsed() >= self.min_refresh) {
                return;
            }
            g.attempted = Some(Instant::now());
        }
        match blocking(|| (self.fetch)(&self.url)) {
            Ok(set) => {
                let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                g.keys = set.keys;
                g.fetched = Some(Instant::now());
            }
            Err(e) => {
                let kept = self.inner.lock().unwrap_or_else(|e| e.into_inner()).keys.len();
                eprintln!("auth: issuer '{}': JWKS fetch from {} failed ({e}); keeping {kept} cached key(s)", self.name, self.url);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    fn jwk(kid: &str) -> Jwk {
        serde_json::from_value(serde_json::json!({
            "kty": "EC", "crv": "P-256", "kid": kid,
            "x": "zIuK7TFq7QBUCmVV79DdRWNU0X4pgTitF40Ef1v0S-c", "y": "E7G8dUDBDrfnEc4imYTRQ7zUYl2oKT4e9Df3Yw1ej8g",
        }))
        .unwrap()
    }

    struct Fake {
        calls: Arc<AtomicUsize>,
        kids:  Arc<Mutex<Vec<String>>>,
        fail:  Arc<AtomicBool>,
    }

    fn fake(kids: &[&str]) -> (Fake, FetchFn) {
        let f = Fake {
            calls: Arc::new(AtomicUsize::new(0)),
            kids:  Arc::new(Mutex::new(kids.iter().map(|s| (*s).to_owned()).collect())),
            fail:  Arc::new(AtomicBool::new(false)),
        };
        let (c, k, fl) = (f.calls.clone(), f.kids.clone(), f.fail.clone());
        let fetch: FetchFn = Box::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            if fl.load(Ordering::SeqCst) {
                return Err("boom".into());
            }
            Ok(JwkSet { keys: k.lock().unwrap().iter().map(|id| jwk(id)).collect() })
        });
        (f, fetch)
    }

    fn jwks(fetch: FetchFn, ttl_ms: u64, min_ms: u64) -> Jwks {
        Jwks::new("hub", "https://x/jwks", Duration::from_millis(ttl_ms), Duration::from_millis(min_ms), fetch)
    }

    #[test]
    fn the_first_lookup_fetches_and_later_ones_use_the_cache() {
        let (f, fetch) = fake(&["a"]);
        let j = jwks(fetch, 60_000, 0);
        assert!(j.key(Some("a")).is_some());
        assert!(j.key(Some("a")).is_some());
        assert!(j.key(Some("a")).is_some());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_rotated_key_is_picked_up_on_an_unknown_kid() {
        let (f, fetch) = fake(&["old"]);
        let j = jwks(fetch, 60_000, 0);
        assert!(j.key(Some("old")).is_some());
        assert!(j.key(Some("new")).is_none());
        f.kids.lock().unwrap().push("new".into());
        assert!(j.key(Some("new")).is_some(), "refreshed because the kid was unknown");
        assert!(j.key(Some("old")).is_some(), "the overlap keeps the old key");
    }

    #[test]
    fn a_flood_of_unknown_kids_causes_at_most_one_fetch_per_interval() {
        let (f, fetch) = fake(&["a"]);
        let j = jwks(fetch, 60_000, 60_000);
        assert!(j.key(Some("a")).is_some());
        for i in 0..500 {
            assert!(j.key(Some(&format!("bogus-{i}"))).is_none());
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 1, "only the initial fetch");
    }

    #[test]
    fn after_the_interval_one_more_fetch_is_allowed() {
        let (f, fetch) = fake(&["a"]);
        let j = jwks(fetch, 60_000, 80);
        assert!(j.key(Some("a")).is_some());
        assert!(j.key(Some("x")).is_none());
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        std::thread::sleep(Duration::from_millis(100));
        assert!(j.key(Some("x")).is_none());
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
        for _ in 0..50 {
            j.key(Some("x"));
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stale_keys_keep_working_when_the_issuer_is_down() {
        let (f, fetch) = fake(&["a"]);
        let j = jwks(fetch, 30, 0);
        assert!(j.key(Some("a")).is_some());
        f.fail.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(50)); // now stale
        assert!(j.key(Some("a")).is_some(), "served from the stale cache");
        assert!(f.calls.load(Ordering::SeqCst) >= 2, "a refresh was attempted");
    }

    #[test]
    fn expired_keys_are_refreshed_when_the_issuer_is_up() {
        let (f, fetch) = fake(&["a"]);
        let j = jwks(fetch, 30, 0);
        assert!(j.key(Some("a")).is_some());
        f.kids.lock().unwrap().clear();
        f.kids.lock().unwrap().push("b".into());
        std::thread::sleep(Duration::from_millis(50));
        assert!(j.key(Some("b")).is_some());
        assert!(j.key(Some("a")).is_none(), "the issuer retired it");
    }

    #[test]
    fn an_initial_failure_is_retried_only_after_the_interval() {
        let (f, fetch) = fake(&["a"]);
        f.fail.store(true, Ordering::SeqCst);
        let j = jwks(fetch, 60_000, 80);
        for _ in 0..20 {
            assert!(j.key(Some("a")).is_none());
        }
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.fail.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert!(j.key(Some("a")).is_some());
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn without_a_kid_only_a_single_key_set_is_usable() {
        let (_f, fetch) = fake(&["only"]);
        assert!(jwks(fetch, 60_000, 0).key(None).is_some());
        let (_f, fetch) = fake(&["a", "b"]);
        assert!(jwks(fetch, 60_000, 0).key(None).is_none());
    }

    #[test]
    fn concurrent_first_requests_share_one_fetch_and_all_get_the_key() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let fetch: FetchFn = Box::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(80));
            Ok(JwkSet { keys: vec![jwk("a")] })
        });
        let j = Arc::new(jwks(fetch, 60_000, 60_000));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let j = j.clone();
                std::thread::spawn(move || j.key(Some("a")).is_some())
            })
            .collect();
        assert!(handles.into_iter().all(|h| h.join().unwrap()), "no request was refused during the cold start");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
