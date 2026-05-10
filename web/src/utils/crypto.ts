export interface Envelope {
  v: number;
  iv: string;
  d: string;
  cs: string;
}

// ── Base58 (Bitcoin alphabet — no 0/O/I/l ambiguity) ─────────────────────────
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHA[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  let n = BigInt(0);
  for (const c of s) {
    const idx = B58_ALPHA.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function isBase58(s: string): boolean {
  return s.length > 0 && [...s].every((c) => B58_ALPHA.includes(c));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Web Crypto requires ArrayBuffer-backed Uint8Array
function toFixed(u: Uint8Array): Uint8Array {
  if (u.buffer instanceof ArrayBuffer) return u;
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy;
}

function keyToBytes(keyStr: string): Uint8Array {
  // Hex: exactly 64 hex chars
  if (keyStr.length === 64 && /^[0-9a-fA-F]+$/.test(keyStr)) {
    return new Uint8Array(keyStr.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }
  // Base58: all chars in B58 alphabet, no +/= (distinguishes from base64)
  if (isBase58(keyStr) && !keyStr.includes('+') && !keyStr.includes('/') && !keyStr.includes('=')) {
    return decodeBase58(keyStr);
  }
  // Default: base64
  return b64decode(keyStr);
}

async function importKey(keyStr: string): Promise<CryptoKey> {
  const raw = keyToBytes(keyStr);
  if (raw.length !== 32) throw new Error(`AES key must be 32 bytes, got ${raw.length}`);
  return crypto.subtle.importKey('raw', toFixed(raw).buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', toFixed(data).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function encrypt(plaintext: string, keyStr: string): Promise<Envelope> {
  const key = await importKey(keyStr);
  const ivRaw = crypto.getRandomValues(new Uint8Array(12));
  const iv = toFixed(ivRaw);
  const encoded = toFixed(new TextEncoder().encode(plaintext));
  const cs = (await sha256hex(encoded)).slice(0, 8);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoded.buffer as ArrayBuffer,
  );
  return {
    v: 1,
    iv: b64encode(iv),
    d: b64encode(new Uint8Array(ciphertext)),
    cs,
  };
}

export async function decrypt(raw: string, keyStr: string): Promise<string> {
  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    throw new Error('not-copa-mqtt');
  }
  if (typeof envelope.v !== 'number' || envelope.v !== 1) throw new Error('not-copa-mqtt');
  const key = await importKey(keyStr);
  const iv = toFixed(b64decode(envelope.iv));
  const ciphertext = toFixed(b64decode(envelope.d));
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer,
  );
  const plaintext = new TextDecoder().decode(plainBuffer);
  const cs = (await sha256hex(new TextEncoder().encode(plaintext))).slice(0, 8);
  if (cs !== envelope.cs) throw new Error('checksum-mismatch');
  return plaintext;
}

/** Generate a new random 32-byte key, returned as base64. */
export function generateKey(): string {
  return b64encode(toFixed(crypto.getRandomValues(new Uint8Array(32))));
}

/** Re-encode any accepted key format (base64/hex/base58) as base58. */
export function keyToBase58(keyStr: string): string {
  return encodeBase58(toFixed(keyToBytes(keyStr)));
}
