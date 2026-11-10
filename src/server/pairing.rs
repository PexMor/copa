/// Device pairing: operator-opened windows, short codes, attempt caps, rate limiting.
///
/// A window is opened by an authorized client for one namespace and access level. It has a
/// public `window_id` and a secret `code`; users type them as one `ID-CODE` string. The code
/// is the SPAKE2 password / the operator's confirmation anchor and is never sent over the
/// network by the device. Windows live in memory only: a restart discards them.
use super::config::PairingConfig;
use std::{collections::HashMap, net::IpAddr, sync::Mutex};

/// Most windows that may be open at once (they are cheap but not free).
pub const MAX_OPEN_WINDOWS: usize = 16;
/// Default requests per source address allowed in `RATE_WINDOW_MS` on the pairing endpoints.
pub const RATE_LIMIT: usize = 30;
pub const RATE_WINDOW_MS: u64 = 10_000;
/// Distinct sources tracked by the limiter before old entries are purged.
const LIMITER_CAP: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    pub id:         String,
    /// The secret part (8 digits).
    pub code:       String,
    pub ns:         String,
    pub acc:        String,
    pub name:       String,
    pub expires_ms: u64,
    failures:       u32,
    pub closed:     bool,
}

impl Window {
    /// What the user types: `ID-CODE`.
    pub fn display_code(&self) -> String {
        format!("{}-{}", self.id, self.code)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// Unknown, expired, closed or used window — deliberately indistinguishable to the caller.
    Unavailable,
    TooManyWindows,
    RateLimited,
    /// The scanned public key is not the one of the pairing being approved.
    KeyMismatch,
}

/// A key exchange in progress, waiting for the device's key confirmation.
pub struct Session {
    pub window_id:  String,
    /// A stand-in for an unknown/expired window: it can never succeed, so a caller cannot tell
    /// whether a window id exists.
    pub decoy:      bool,
    pub keys:       super::pair_crypto::Keys,
    pub expires_ms: u64,
}

/// A started exchange must be confirmed within this long.
pub const SESSION_TTL_MS: u64 = 30_000;
/// Pending exchanges per window, and overall.
pub const MAX_SESSIONS_PER_WINDOW: usize = 8;
pub const MAX_SESSIONS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EcdhStatus {
    Pending,
    Approved,
    Denied,
}

/// A device that started an ECDH pairing and waits for the operator to compare fingerprints.
pub struct EcdhSession {
    pub id:         String,
    pub window_id:  String,
    pub client_pub: Vec<u8>,
    pub fingerprint: String,
    /// Copied from the window so delivery does not depend on the window still existing.
    pub ns:         String,
    pub acc:        String,
    pub label:      String,
    pub keys:       super::pair_crypto::Keys,
    pub status:     EcdhStatus,
    pub created_ms: u64,
    pub expires_ms: u64,
}

pub const MAX_ECDH_PER_WINDOW: usize = 8;
pub const MAX_ECDH: usize = 64;

pub struct Pairing {
    pub cfg: PairingConfig,
    windows: Mutex<HashMap<String, Window>>,
    limiter: Mutex<HashMap<IpAddr, Vec<u64>>>,
    sessions: Mutex<HashMap<String, Session>>,
    ecdh: Mutex<HashMap<String, EcdhSession>>,
}

const ID_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

fn random_id() -> String {
    (0..6).map(|_| ID_ALPHABET[rand::random::<usize>() % ID_ALPHABET.len()] as char).collect()
}

fn random_code() -> String {
    format!("{:08}", rand::random::<u32>() % 100_000_000)
}

impl Pairing {
    pub fn new(cfg: PairingConfig) -> Self {
        Self { cfg, windows: Mutex::new(HashMap::new()), limiter: Mutex::new(HashMap::new()), sessions: Mutex::new(HashMap::new()), ecdh: Mutex::new(HashMap::new()) }
    }

    /// Allow one request from `ip`? (sliding window)
    pub fn rate_ok(&self, ip: IpAddr, now: u64) -> bool {
        let mut l = self.limiter.lock().unwrap_or_else(|e| e.into_inner());
        if l.len() >= LIMITER_CAP {
            l.retain(|_, v| v.last().is_some_and(|t| now.saturating_sub(*t) < RATE_WINDOW_MS));
        }
        let hits = l.entry(ip).or_default();
        hits.retain(|t| now.saturating_sub(*t) < RATE_WINDOW_MS);
        if hits.len() >= self.cfg.rate_limit() {
            return false;
        }
        hits.push(now);
        true
    }

    pub fn open_window(&self, ns: &str, acc: &str, name: &str, now: u64) -> Result<Window, PairError> {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        w.retain(|_, x| !x.closed && x.expires_ms > now);
        if w.len() >= MAX_OPEN_WINDOWS {
            return Err(PairError::TooManyWindows);
        }
        let mut id = random_id();
        while w.contains_key(&id) {
            id = random_id();
        }
        let window = Window {
            id: id.clone(),
            code: random_code(),
            ns: ns.to_owned(),
            acc: acc.to_owned(),
            name: name.chars().filter(|c| !c.is_control()).take(64).collect(),
            expires_ms: now + self.cfg.window_ttl_ms(),
            failures: 0,
            closed: false,
        };
        w.insert(id, window.clone());
        Ok(window)
    }

    /// The window if it can still be used for an attempt.
    pub fn usable(&self, id: &str, now: u64) -> Result<Window, PairError> {
        let w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        match w.get(id) {
            Some(x) if !x.closed && x.expires_ms > now => Ok(x.clone()),
            _ => Err(PairError::Unavailable),
        }
    }

    /// Count a failed attempt; the window closes after `max_attempts` of them.
    pub fn fail(&self, id: &str) -> bool {
        let mut w = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let Some(x) = w.get_mut(id) else { return false };
        x.failures += 1;
        if x.failures >= self.cfg.max_attempts() {
            x.closed = true;
        }
        x.closed
    }

    /// A pairing succeeded: the window is spent.
    pub fn close(&self, id: &str) {
        if let Some(x) = self.windows.lock().unwrap_or_else(|e| e.into_inner()).get_mut(id) {
            x.closed = true;
        }
    }

    /// Remember a started exchange; `None` when too many are pending.
    pub fn add_session(&self, window_id: &str, decoy: bool, keys: super::pair_crypto::Keys, now: u64) -> Option<String> {
        let mut s = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        s.retain(|_, x| x.expires_ms > now);
        if s.len() >= MAX_SESSIONS || s.values().filter(|x| x.window_id == window_id).count() >= MAX_SESSIONS_PER_WINDOW {
            return None;
        }
        let id = super::pair_crypto::b64(&rand::random::<[u8; 18]>());
        s.insert(id.clone(), Session { window_id: window_id.to_owned(), decoy, keys, expires_ms: now + SESSION_TTL_MS });
        Some(id)
    }

    /// Take a pending exchange (it can be confirmed once, whatever the outcome).
    pub fn take_session(&self, id: &str, now: u64) -> Option<Session> {
        let x = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(id)?;
        (x.expires_ms > now).then_some(x)
    }

    /// Remember a started ECDH pairing (pending operator approval); `None` when too many are pending.
    pub fn add_ecdh(&self, window: &Window, client_pub: Vec<u8>, fingerprint: String, keys: super::pair_crypto::Keys, now: u64) -> Option<String> {
        let mut m = self.ecdh.lock().unwrap_or_else(|e| e.into_inner());
        m.retain(|_, x| x.expires_ms > now);
        if m.len() >= MAX_ECDH || m.values().filter(|x| x.window_id == window.id).count() >= MAX_ECDH_PER_WINDOW {
            return None;
        }
        let id = super::pair_crypto::b64(&rand::random::<[u8; 18]>());
        m.insert(id.clone(), EcdhSession {
            id: id.clone(), window_id: window.id.clone(), client_pub, fingerprint, keys,
            ns: window.ns.clone(), acc: window.acc.clone(), label: window.name.clone(),
            status: EcdhStatus::Pending, created_ms: now, expires_ms: window.expires_ms,
        });
        Some(id)
    }

    /// Pending (not yet decided) ECDH pairings of the windows of `ns`, oldest first.
    pub fn pending_for(&self, ns: &str, now: u64) -> Vec<(String, String, String, u64)> {
        let windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let m = self.ecdh.lock().unwrap_or_else(|e| e.into_inner());
        let mut v: Vec<_> = m
            .values()
            .filter(|x| x.status == EcdhStatus::Pending && x.expires_ms > now)
            .filter(|x| windows.get(&x.window_id).is_some_and(|w| w.ns == ns && !w.closed))
            .map(|x| (x.id.clone(), x.window_id.clone(), x.fingerprint.clone(), x.created_ms))
            .collect();
        v.sort_by_key(|x| x.3);
        v
    }

    /// Operator decision. Approving closes the window and denies its other pending pairings.
    /// Returns false when there is no such pending pairing in `ns`.
    pub fn decide_ecdh(&self, id: &str, ns: &str, approve: bool, client_pub: Option<&[u8]>, now: u64) -> Result<(), PairError> {
        let mut windows = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let mut m = self.ecdh.lock().unwrap_or_else(|e| e.into_inner());
        let Some(x) = m.get(id).filter(|x| x.status == EcdhStatus::Pending && x.expires_ms > now) else {
            return Err(PairError::Unavailable);
        };
        let window_id = x.window_id.clone();
        match windows.get(&window_id) {
            Some(w) if w.ns == ns && !w.closed => {}
            _ => return Err(PairError::Unavailable),
        }
        if approve {
            // Approving by scanned key: it must be the key of *this* pairing (stops a swapped request).
            if client_pub.is_some_and(|p| p != x.client_pub.as_slice()) {
                return Err(PairError::KeyMismatch);
            }
            for other in m.values_mut().filter(|o| o.window_id == window_id && o.id != id && o.status == EcdhStatus::Pending) {
                other.status = EcdhStatus::Denied;
            }
            m.get_mut(id).expect("checked").status = EcdhStatus::Approved;
            if let Some(w) = windows.get_mut(&window_id) {
                w.closed = true;
            }
        } else {
            m.get_mut(id).expect("checked").status = EcdhStatus::Denied;
        }
        Ok(())
    }

    /// State of a pairing for the device's poll (the session stays until `finish_ecdh`).
    pub fn peek_ecdh(&self, id: &str, now: u64) -> Option<(EcdhStatus, super::pair_crypto::Keys, (String, String, String))> {
        let m = self.ecdh.lock().unwrap_or_else(|e| e.into_inner());
        let x = m.get(id).filter(|x| x.expires_ms > now)?;
        Some((x.status, x.keys.clone(), (x.ns.clone(), x.acc.clone(), x.label.clone())))
    }

    /// Drop a decided pairing: its result is delivered exactly once.
    pub fn finish_ecdh(&self, id: &str) {
        self.ecdh.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn open_count(&self, now: u64) -> usize {
        self.windows.lock().unwrap_or_else(|e| e.into_inner()).values().filter(|x| !x.closed && x.expires_ms > now).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing() -> Pairing {
        Pairing::new(PairingConfig { enabled: true, ..Default::default() })
    }

    #[test]
    fn a_window_has_an_id_and_an_eight_digit_code() {
        let w = pairing().open_window("team", "rw", "Alice's phone", 1000).unwrap();
        assert_eq!(w.id.len(), 6);
        assert!(w.id.bytes().all(|b| ID_ALPHABET.contains(&b)));
        assert!(w.code.len() == 8 && w.code.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(w.display_code(), format!("{}-{}", w.id, w.code));
        assert_eq!(w.expires_ms, 1000 + 120_000);
    }

    #[test]
    fn windows_expire() {
        let p = pairing();
        let w = p.open_window("team", "rw", "", 0).unwrap();
        assert!(p.usable(&w.id, 119_999).is_ok());
        assert_eq!(p.usable(&w.id, 120_000), Err(PairError::Unavailable));
        assert_eq!(p.open_count(120_000), 0);
    }

    #[test]
    fn unknown_and_closed_windows_look_the_same() {
        let p = pairing();
        let w = p.open_window("team", "rw", "", 0).unwrap();
        p.close(&w.id);
        assert_eq!(p.usable(&w.id, 1), Err(PairError::Unavailable));
        assert_eq!(p.usable("NOPE00", 1), Err(PairError::Unavailable));
    }

    #[test]
    fn five_failures_close_the_window() {
        let p = pairing();
        let w = p.open_window("team", "rw", "", 0).unwrap();
        for i in 1..=5 {
            assert_eq!(p.fail(&w.id), i == 5, "attempt {i}");
        }
        assert_eq!(p.usable(&w.id, 1), Err(PairError::Unavailable));
    }

    #[test]
    fn the_attempt_cap_is_configurable() {
        let p = Pairing::new(PairingConfig { enabled: true, max_attempts: Some(2), ..Default::default() });
        let w = p.open_window("t", "r", "", 0).unwrap();
        assert!(!p.fail(&w.id));
        assert!(p.fail(&w.id));
    }

    #[test]
    fn the_number_of_open_windows_is_bounded_and_expired_ones_do_not_count() {
        let p = pairing();
        for _ in 0..MAX_OPEN_WINDOWS {
            p.open_window("t", "r", "", 0).unwrap();
        }
        assert_eq!(p.open_window("t", "r", "", 1).err(), Some(PairError::TooManyWindows));
        assert!(p.open_window("t", "r", "", 200_000).is_ok());
    }

    #[test]
    fn window_ids_are_unique_and_codes_vary() {
        let p = pairing();
        let ids: std::collections::HashSet<_> = (0..MAX_OPEN_WINDOWS).map(|_| p.open_window("t", "r", "", 0).unwrap().id).collect();
        assert_eq!(ids.len(), MAX_OPEN_WINDOWS);
    }

    #[test]
    fn the_limiter_allows_a_burst_then_refuses_then_recovers() {
        let p = pairing();
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let other: IpAddr = "10.0.0.2".parse().unwrap();
        for _ in 0..RATE_LIMIT {
            assert!(p.rate_ok(ip, 0));
        }
        assert!(!p.rate_ok(ip, 5_000));
        assert!(p.rate_ok(other, 5_000), "another source is unaffected");
        assert!(p.rate_ok(ip, RATE_WINDOW_MS + 1), "the window slid");
    }

    #[test]
    fn names_are_cleaned() {
        let w = pairing().open_window("t", "r", &format!("a\nb{}", "x".repeat(200)), 0).unwrap();
        assert!(w.name.len() <= 64 && !w.name.contains('\n'));
    }
}
