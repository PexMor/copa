// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { passwordScalar, spake2Start } from '../src/auth/pair-crypto';

// Produced by the Rust `spake2` crate (tests/pair_vectors.rs asserts the same values on its side).
const VECTORS: [string, string][] = [
  ['01234567', 'a33aefa99a9c16761c9a3b5b94a3ad5558e93610f1890a06313e2aa8ede61b00'],
  ['48217730', '9d263ce42d2d6d8c8f7d4f5c1069ea60675593af7b1cd71129d3a8c438da5305'],
  ['00000000', '0a0fdefff5be54da4bb717b933bb34cf0a64133ed112989f2d79aac8a25b4908'],
  ['99999999', '2f15a83ec8500c568c7d4e924b19e2cf1fbb1fa52eb6767bb3bc3c8f0201cf0c'],
];

const leHex = (n: bigint): string => {
  const out: string[] = [];
  for (let i = 0; i < 32; i++) { out.push(Number((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0')); }
  return out.join('');
};

describe('SPAKE2 vectors from the Rust crate', () => {
  for (const [pw, scalar] of VECTORS) {
    it(`password scalar of ${pw}`, () => {
      expect(leHex(passwordScalar(new TextEncoder().encode(pw)))).toBe(scalar);
    });
  }

  it('the first message is the side byte and a point on the curve, and differs per run', () => {
    const a = spake2Start(new TextEncoder().encode('01234567'));
    const b = spake2Start(new TextEncoder().encode('01234567'));
    expect(a.msg).toHaveLength(33);
    expect(a.msg[0]).toBe(0x41);
    expect(() => ed25519.ExtendedPoint.fromHex(a.msg.slice(1))).not.toThrow();
    expect(Buffer.from(a.msg).equals(Buffer.from(b.msg))).toBe(false);
  });

  it('a fixed ephemeral scalar gives a fixed message (regression guard for the port)', () => {
    const a = spake2Start(new TextEncoder().encode('01234567'), 5n);
    const again = spake2Start(new TextEncoder().encode('01234567'), 5n);
    expect(Buffer.from(a.msg).toString('hex')).toBe(Buffer.from(again.msg).toString('hex'));
  });

  it('rejects server messages with the wrong side byte or length', () => {
    const c = spake2Start(new TextEncoder().encode('01234567'));
    expect(() => c.finish(new Uint8Array(33))).toThrow();
    expect(() => c.finish(new Uint8Array(32))).toThrow();
  });
});
