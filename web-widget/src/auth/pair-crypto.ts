/**
 * Client side of copa's pairing protocols. Mirrors `src/server/pair_crypto.rs` and the
 * `spake2` crate (Ed25519 group) byte for byte; the tests run it against the real server.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToNumberBE } from '@noble/curves/abstract/utils';

const enc = new TextEncoder();
const Point = ed25519.ExtendedPoint;
const L = ed25519.CURVE.n;

export const ID_CLIENT = enc.encode('copa-widget');
export const ID_SERVER = enc.encode('copa-server');

// ── base64url ───────────────────────────────────────────────────────────────

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const be32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// ── key schedule (identical to pair_crypto.rs) ──────────────────────────────

export interface Keys {
  clientMac: Uint8Array;
  serverMac: Uint8Array;
  enc: Uint8Array;
  transcript: Uint8Array;
}

/** Length-prefixed, so different inputs can never concatenate alike. */
export function transcript(protocol: string, parts: Uint8Array[]): Uint8Array {
  const proto = enc.encode(protocol);
  return sha256(concat(be32(proto.length), proto, ...parts.flatMap((p) => [be32(p.length), p])));
}

const expand = (ikm: Uint8Array, info: string): Uint8Array => hkdf(sha256, ikm, new Uint8Array(0), enc.encode(info), 32);

export function deriveKeys(shared: Uint8Array, t: Uint8Array): Keys {
  return {
    clientMac: expand(shared, 'copa-pair/v1/client-mac'),
    serverMac: expand(shared, 'copa-pair/v1/server-mac'),
    enc: expand(shared, 'copa-pair/v1/encrypt'),
    transcript: t,
  };
}

export const mac = (key: Uint8Array, label: 'client' | 'server', t: Uint8Array): Uint8Array =>
  hmac(sha256, key, concat(enc.encode(label), t));

export function macEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Four groups of four digits: the first 8 bytes of the transcript, big-endian, modulo 10^16. */
export function fingerprint(t: Uint8Array): string {
  const n = (bytesToNumberBE(t.slice(0, 8)) % 10_000_000_000_000_000n).toString().padStart(16, '0');
  return `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8, 12)} ${n.slice(12, 16)}`;
}

/** Open `nonce(12) || ciphertext` (AES-256-GCM, transcript as associated data). Null when it does not authenticate. */
export async function open(key: Uint8Array, t: Uint8Array, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < 12 + 16) return null;
  try {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) as BufferSource, additionalData: t as BufferSource }, k, sealed.slice(12) as BufferSource);
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

// ── SPAKE2, side A, Ed25519 group (port of spake2 0.4) ──────────────────────

const M = Point.fromHex('15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312');
const N = Point.fromHex('f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3');

/** HKDF(salt = "", info = "SPAKE2 pw", 48 bytes), read as a big-endian integer, reduced mod the group order. */
export function passwordScalar(password: Uint8Array): bigint {
  const okm = hkdf(sha256, password, new Uint8Array(0), enc.encode('SPAKE2 pw'), 48);
  return bytesToNumberBE(okm) % L;
}

export interface Spake2Client {
  /** Side byte 0x41 ("A") + the 32-byte point. */
  msg: Uint8Array;
  /** Finish with the server's message; returns the 32-byte shared key (the SPAKE2 transcript hash). */
  finish(msgB: Uint8Array): Uint8Array;
}

/** `scalar` is only for tests (a fixed ephemeral value); real use leaves it out. */
export function spake2Start(password: Uint8Array, scalar?: bigint): Spake2Client {
  const pw = passwordScalar(password);
  let x = scalar ?? 0n;
  while (x === 0n) x = bytesToNumberBE(crypto.getRandomValues(new Uint8Array(64))) % L;
  const X = Point.BASE.multiply(x).add(M.multiply(pw));
  const msgA = concat(new Uint8Array([0x41]), X.toRawBytes());
  return {
    msg: msgA,
    finish(msgB) {
      if (msgB.length !== 33 || msgB[0] !== 0x42) throw new Error('bad SPAKE2 message');
      const Y = Point.fromHex(msgB.slice(1));
      // K = (Y - pw*N) * x
      const K = Y.add(N.multiply(pw).negate()).multiply(x);
      const h = (b: Uint8Array) => sha256(b);
      return sha256(concat(h(password), h(ID_CLIENT), h(ID_SERVER), msgA.slice(1), msgB.slice(1), K.toRawBytes()));
    },
  };
}
