//! Fixed vectors from the `spake2` crate; the JavaScript port is checked against the same values
//! (web-widget/test/vectors.test.ts). If the crate ever changes them, both sides must be revisited.
use spake2::{Ed25519Group, Group};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub const VECTORS: [(&str, &str); 4] = [
    ("01234567", "a33aefa99a9c16761c9a3b5b94a3ad5558e93610f1890a06313e2aa8ede61b00"),
    ("48217730", "9d263ce42d2d6d8c8f7d4f5c1069ea60675593af7b1cd71129d3a8c438da5305"),
    ("00000000", "0a0fdefff5be54da4bb717b933bb34cf0a64133ed112989f2d79aac8a25b4908"),
    ("99999999", "2f15a83ec8500c568c7d4e924b19e2cf1fbb1fa52eb6767bb3bc3c8f0201cf0c"),
];

#[test]
fn password_scalars_match_the_published_vectors() {
    for (pw, expected) in VECTORS {
        assert_eq!(hex(Ed25519Group::hash_to_scalar(pw.as_bytes()).as_bytes()), expected, "{pw}");
    }
}
