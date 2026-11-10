import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import { invalid, valid } from './config-fixtures';

const oneEndpoint = (url: string, auth: unknown) => ({ version: 1, endpoints: [{ id: 'a', url, auth }] });

describe('validateConfig: fixtures', () => {
  for (const [name, input] of Object.entries(valid)) {
    it(`accepts ${name}`, () => {
      const r = validateConfig(input);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
  for (const [name, input] of Object.entries(invalid)) {
    it(`rejects ${name}`, () => {
      const r = validateConfig(input);
      // an endpoint with errors is refused; the document has nothing usable left
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  }
});

describe('spec: JSON configuration document', () => {
  it('minimal config connects to the default namespace', () => {
    const r = validateConfig(valid['minimal static token']);
    expect(r.config?.endpoints[0]).toMatchObject({ id: 'a', namespace: 'default', url: 'https://copa.example.com' });
  });

  it('keeps several endpoints and the default endpoint', () => {
    const r = validateConfig(valid['multiple endpoints']);
    expect(r.config?.endpoints.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.config?.defaultEndpoint).toBe('b');
    expect(r.config?.endpoints[1].namespace).toBe('team');
  });

  it('strips a trailing slash from endpoint URLs', () => {
    const r = validateConfig(oneEndpoint('https://c.example.com/', { method: 'pairing', protocol: 'spake2' }));
    expect(r.config?.endpoints[0].url).toBe('https://c.example.com');
  });

  it('refuses only the broken endpoint, keeps the others', () => {
    const r = validateConfig({
      version: 1,
      endpoints: [
        { id: 'bad', url: 'https://c.example.com', auth: { method: 'kerberos' } },
        { id: 'good', url: 'https://c.example.com', auth: { method: 'pairing', protocol: 'ecdh' } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.config?.endpoints.map((e) => e.id)).toEqual(['good']);
    expect(r.errors[0].path).toBe('endpoints[0].auth.method');
  });

  it('rejects duplicate endpoint ids and an unknown defaultEndpoint', () => {
    const dup = validateConfig({ version: 1, endpoints: [valid['minimal static token'] as never, valid['minimal static token'] as never]
      .map(() => ({ id: 'a', url: 'https://c.example.com', auth: { method: 'pairing', protocol: 'spake2' } })) });
    expect(dup.errors.some((e) => e.code === 'duplicate-id')).toBe(true);
    const unk = validateConfig({ ...(valid['minimal static token'] as object), defaultEndpoint: 'zzz' });
    expect(unk.errors.some((e) => e.code === 'unknown-endpoint')).toBe(true);
  });
});

describe('spec: supported authentication methods', () => {
  it('unknown method names the invalid field', () => {
    const r = validateConfig(invalid['unknown method']);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'unknown-method', path: 'endpoints[0].auth.method' })]);
  });

  it('oauth2 without tokenService reports the missing key', () => {
    const r = validateConfig(invalid['oauth2 missing tokenService']);
    expect(r.errors[0]).toMatchObject({ code: 'required', path: 'endpoints[0].auth.tokenService' });
  });

  it('identity-provider secrets are rejected with an explanation', () => {
    for (const k of ['clientSecret', 'clientId']) {
      const r = validateConfig(doc(k));
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatchObject({ code: 'idp-secret', path: `endpoints[0].auth.${k}` });
      expect(r.errors[0].message).toMatch(/token service/);
    }
    function doc(k: string) {
      return oneEndpoint('https://c.example.com', { method: 'oauth2', tokenService: 'https://t.example.com', [k]: 'x' });
    }
  });

  it('static-token requires exactly one source', () => {
    expect(validateConfig(invalid['static token missing both']).errors[0].code).toBe('one-of');
    expect(validateConfig(invalid['static token both']).errors[0].code).toBe('one-of');
  });
});

describe('spec: validation before use', () => {
  it('rejects http for non-loopback endpoint URLs', () => {
    const r = validateConfig(invalid['insecure url']);
    expect(r.errors[0]).toMatchObject({ code: 'insecure-url', path: 'endpoints[0].url' });
  });

  it('rejects an http token service that is not loopback', () => {
    const r = validateConfig(invalid['oauth2 insecure tokenService']);
    expect(r.errors[0]).toMatchObject({ code: 'insecure-url', path: 'endpoints[0].auth.tokenService' });
  });

  it('accepts loopback http (127.0.0.1, localhost, ::1)', () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
      expect(validateConfig(oneEndpoint(url, { method: 'pairing', protocol: 'spake2' })).ok).toBe(true);
    }
  });

  it('rejects a newer major version and makes no endpoint usable', () => {
    const r = validateConfig(invalid['newer version']);
    expect(r.ok).toBe(false);
    expect(r.config).toBeUndefined();
    expect(r.errors[0]).toMatchObject({ code: 'version-unsupported' });
    expect(r.errors[0].message).toMatch(/upgrade/);
  });

  it('warns about unknown optional keys but keeps working', () => {
    const r = validateConfig({
      version: 1, flavour: 'x',
      endpoints: [{ id: 'a', url: 'https://c.example.com', extra: 1, auth: { method: 'pairing', protocol: 'spake2', wat: 1 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining([
      'flavour: unknown key ignored', 'endpoints[0].extra: unknown key ignored', 'endpoints[0].auth.wat: unknown key ignored',
    ]));
  });
});
