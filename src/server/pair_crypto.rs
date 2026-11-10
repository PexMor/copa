/// Key schedule shared by both pairing protocols.
///
/// Both end up with a 32-byte shared secret (`K`: SPAKE2 key / ECDH secret). From it, and
/// from a transcript hash `T` that binds the exchange, we derive:
///   * a MAC key per direction, so each side proves it knows `K` (key confirmation);
///   * an encryption key, used to deliver the credential only to the party that proved it.
///
/// Info strings are versioned (`copa-pair/v1/…`) and the client's JS implementation mirrors them.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

pub const INFO_CLIENT_MAC: &[u8] = b"copa-pair/v1/client-mac";
pub const INFO_SERVER_MAC: &[u8] = b"copa-pair/v1/server-mac";
pub const INFO_ENCRYPT: &[u8] = b"copa-pair/v1/encrypt";
pub const LABEL_CLIENT: &[u8] = b"client";
pub const LABEL_SERVER: &[u8] = b"server";

#[derive(Clone)]
pub struct Keys {
    pub client_mac: [u8; 32],
    pub server_mac: [u8; 32],
    pub enc:        [u8; 32],
    /// Transcript hash; also the AEAD associated data.
    pub transcript: [u8; 32],
}

fn expand(ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b""), ikm).expand(info, &mut out).expect("32 bytes is a valid length");
    out
}

/// `parts` are length-prefixed into the transcript so that no two different inputs concatenate alike.
pub fn transcript(protocol: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update((protocol.len() as u32).to_be_bytes());
    h.update(protocol.as_bytes());
    for p in parts {
        h.update((p.len() as u32).to_be_bytes());
        h.update(p);
    }
    h.finalize().into()
}

pub fn derive(shared: &[u8], transcript: [u8; 32]) -> Keys {
    Keys {
        client_mac: expand(shared, INFO_CLIENT_MAC),
        server_mac: expand(shared, INFO_SERVER_MAC),
        enc: expand(shared, INFO_ENCRYPT),
        transcript,
    }
}

pub fn mac(key: &[u8; 32], label: &[u8], transcript: &[u8; 32]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("any key length");
    m.update(label);
    m.update(transcript);
    m.finalize().into_bytes().into()
}

/// Constant-time comparison.
pub fn mac_matches(expected: &[u8; 32], given: &[u8]) -> bool {
    given.len() == 32 && bool::from(expected.as_slice().ct_eq(given))
}

/// `nonce(12) || ciphertext` under AES-256-GCM with the transcript as associated data.
pub fn seal(key: &[u8; 32], transcript: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let nonce: [u8; 12] = rand::random();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: transcript })
        .expect("encryption cannot fail for in-memory data");
    [nonce.to_vec(), ct].concat()
}

pub fn open(key: &[u8; 32], transcript: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    cipher.decrypt(Nonce::from_slice(&sealed[..12]), Payload { msg: &sealed[12..], aad: transcript }).ok()
}

/// Four groups of four digits from a transcript, for humans to compare: `1234 5678 9012 3456`.
/// (First 8 bytes as a big-endian integer, modulo 10^16.)
pub fn fingerprint(transcript: &[u8; 32]) -> String {
    let n = u64::from_be_bytes(transcript[..8].try_into().expect("8 bytes")) % 10_000_000_000_000_000;
    let d = format!("{n:016}");
    format!("{} {} {} {}", &d[0..4], &d[4..8], &d[8..12], &d[12..16])
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_distinct_and_depend_on_the_secret_and_the_transcript() {
        let t = transcript("x", &[b"a"]);
        let k = derive(b"secret", t);
        let all = [k.client_mac, k.server_mac, k.enc];
        assert!(all[0] != all[1] && all[1] != all[2] && all[0] != all[2]);
        assert!(derive(b"other", t).enc != k.enc);
        assert_eq!(derive(b"secret", t).enc, k.enc);
    }

    #[test]
    fn transcripts_are_unambiguous() {
        assert_ne!(transcript("p", &[b"ab", b"c"]), transcript("p", &[b"a", b"bc"]));
        assert_ne!(transcript("p", &[b"a"]), transcript("q", &[b"a"]));
        assert_ne!(transcript("p", &[b"a", b""]), transcript("p", &[b"a"]));
    }

    #[test]
    fn macs_are_directional_and_bound_to_the_transcript() {
        let t = transcript("p", &[b"1"]);
        let k = derive(b"s", t);
        let c = mac(&k.client_mac, LABEL_CLIENT, &t);
        assert!(mac_matches(&c, &mac(&k.client_mac, LABEL_CLIENT, &t)));
        assert!(!mac_matches(&c, &mac(&k.server_mac, LABEL_SERVER, &t)), "a client MAC is not a server MAC");
        assert!(!mac_matches(&c, &mac(&k.client_mac, LABEL_CLIENT, &transcript("p", &[b"2"]))));
        assert!(!mac_matches(&c, &c[..31]) && !mac_matches(&c, &[]));
    }

    #[test]
    fn sealed_data_opens_only_with_the_right_key_and_transcript() {
        let t = transcript("p", &[b"1"]);
        let k = derive(b"s", t);
        let sealed = seal(&k.enc, &t, b"credential");
        assert_eq!(open(&k.enc, &t, &sealed).as_deref(), Some(&b"credential"[..]));
        assert!(open(&derive(b"other", t).enc, &t, &sealed).is_none());
        assert!(open(&k.enc, &transcript("p", &[b"2"]), &sealed).is_none());
        let mut bad = sealed.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(open(&k.enc, &t, &bad).is_none());
        assert!(open(&k.enc, &t, &sealed[..20]).is_none());
        assert_ne!(seal(&k.enc, &t, b"credential"), sealed, "fresh nonce every time");
    }

    #[test]
    fn fingerprints_are_four_groups_of_digits_that_follow_the_transcript() {
        let a = fingerprint(&transcript("ecdh", &[b"1"]));
        assert_eq!(a.len(), 19);
        assert!(a.split(' ').count() == 4 && a.split(' ').all(|g| g.len() == 4 && g.bytes().all(|b| b.is_ascii_digit())), "{a}");
        assert_ne!(a, fingerprint(&transcript("ecdh", &[b"2"])));
        assert_eq!(a, fingerprint(&transcript("ecdh", &[b"1"])));
        // a fixed vector (the JavaScript client must produce the same digits)
        let mut t = [0u8; 32];
        t[..8].copy_from_slice(&1_234_567_890_123_456_789u64.to_be_bytes());
        assert_eq!(fingerprint(&t), "4567 8901 2345 6789"); // 1234567890123456789 mod 10^16
    }

    #[test]
    fn base64_helpers() {
        assert_eq!(unb64(&b64(b"hello")).unwrap(), b"hello");
        assert!(unb64("!!!").is_none());
    }
}
