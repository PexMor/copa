/** Shared by the validator tests and the schema-parity test. */
const ep = (auth: unknown, extra: Record<string, unknown> = {}) =>
  ({ id: 'a', url: 'https://copa.example.com', auth, ...extra });
const doc = (...endpoints: unknown[]) => ({ version: 1, endpoints });

export const valid: Record<string, unknown> = {
  'minimal static token': doc(ep({ method: 'static-token', token: 'abc' })),
  'static tokenFrom': doc(ep({ method: 'static-token', tokenFrom: 'host' })),
  'oauth2 base url': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com' })),
  'oauth2 explicit urls': doc(ep({
    method: 'oauth2', loginUrl: 'https://a.example.com/login', tokenUrl: 'https://a.example.com/token',
    refreshUrl: 'https://a.example.com/refresh', logoutUrl: 'https://a.example.com/logout',
  })),
  'oauth2 full': doc(ep({
    method: 'oauth2', tokenService: 'https://auth.example.com', audience: 'https://copa.example.com',
    popup: { width: 480, height: 640 }, persist: 'session',
  })),
  'oauth2 redirect flow': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com', flow: 'redirect' })),
  'pairing spake2': doc(ep({ method: 'pairing', protocol: 'spake2' })),
  'pairing with persist': doc(ep({ method: 'pairing', protocol: 'spake2', persist: 'session' })),
  'pairing ecdh with ttl': doc(ep({ method: 'pairing', protocol: 'ecdh', ttlHint: 3600 })),
  'loopback http': doc({ id: 'lan', url: 'http://127.0.0.1:8080', auth: { method: 'pairing', protocol: 'spake2' } }),
  'localhost http': doc({ id: 'lan', url: 'http://localhost:8080', auth: { method: 'pairing', protocol: 'spake2' } }),
  'multiple endpoints': {
    version: 1, defaultEndpoint: 'b',
    endpoints: [
      ep({ method: 'static-token', token: 'x' }),
      { id: 'b', url: 'https://b.example.com', namespace: 'team', auth: { method: 'pairing', protocol: 'ecdh' } },
    ],
    ui: { theme: 'dark' },
  },
};

export const invalid: Record<string, unknown> = {
  'not an object': [],
  'missing version': { endpoints: [ep({ method: 'static-token', token: 'x' })] },
  'newer version': { version: 2, endpoints: [ep({ method: 'static-token', token: 'x' })] },
  'no endpoints': { version: 1, endpoints: [] },
  'unknown method': doc(ep({ method: 'kerberos' })),
  'insecure url': doc({ id: 'a', url: 'http://copa.example.com', auth: { method: 'pairing', protocol: 'spake2' } }),
  'static token missing both': doc(ep({ method: 'static-token' })),
  'static token both': doc(ep({ method: 'static-token', token: 'a', tokenFrom: 'b' })),
  'oauth2 missing tokenService': doc(ep({ method: 'oauth2' })),
  'oauth2 insecure tokenService': doc(ep({ method: 'oauth2', tokenService: 'http://auth.example.com' })),
  'oauth2 client secret': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com', clientSecret: 's' })),
  'oauth2 client id': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com', clientId: 'c' })),
  'oauth2 bad persist': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com', persist: 'forever' })),
  'oauth2 bad flow': doc(ep({ method: 'oauth2', tokenService: 'https://auth.example.com', flow: 'iframe' })),
  'oauth2 partial explicit urls': doc(ep({ method: 'oauth2', loginUrl: 'https://a.example.com/login' })),
  'pairing missing protocol': doc(ep({ method: 'pairing' })),
  'pairing bad protocol': doc(ep({ method: 'pairing', protocol: 'srp' })),
  'pairing bad persist': doc(ep({ method: 'pairing', protocol: 'spake2', persist: 'forever' })),
  'pairing bad ttl': doc(ep({ method: 'pairing', protocol: 'spake2', ttlHint: 0 })),
  'endpoint without id': doc({ url: 'https://c.example.com', auth: { method: 'pairing', protocol: 'spake2' } }),
  'endpoint without auth': doc({ id: 'a', url: 'https://c.example.com' }),
  'bad theme': { ...doc(ep({ method: 'static-token', token: 'x' })), ui: { theme: 'neon' } },
};
