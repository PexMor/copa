const CACHE = 'copa-v2';
const PRECACHE = ['/', '/manifest.json', '/icon.svg'];

// A proxy login redirect / page must never be cached or served as an asset.
function isAuthIntercept(request, response) {
  if (response.type === 'opaqueredirect' || response.redirected) return true;
  if (response.status >= 300 && response.status < 400) return true;
  const ct = response.headers.get('content-type') || '';
  return request.mode !== 'navigate' && ct.includes('text/html');
}

async function notifyAuthExpired() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'AUTH_EXPIRED' });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        PRECACHE.map(async (u) => {
          const req = new Request(u, { redirect: 'manual', cache: 'no-store' });
          const r = await fetch(req);
          if (r.ok && !isAuthIntercept(req, r)) await c.put(u, r);
        })
      )
    ).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      ),
      // cached shell may launch with an expired session: tell the page
      fetch('/__access/probe', { cache: 'no-store', redirect: 'manual' })
        .then((r) => {
          const ready = r.status === 204 && r.headers.get('x-app-access-probe') === 'ok';
          if (!ready && r.status !== 404) return notifyAuthExpired();
        })
        .catch(() => {}),
    ])
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch other origins (object-store uploads/downloads via presigned
  // URLs, a copasrv on another host) or anything that is not a plain GET.
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  // Network-only: API, WebSocket and the identity-proxy control plane.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/__access/')
  ) return;

  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    const network = fetch(e.request)
      .then(async (r) => {
        if (isAuthIntercept(e.request, r)) {
          await notifyAuthExpired();
        } else if (r.ok) {
          const c = await caches.open(CACHE);
          await c.put(e.request, r.clone());
        }
        return r;
      })
      .catch(() => null);
    if (cached) {
      e.waitUntil(network);
      return cached;
    }
    return (await network) ?? Response.error();
  })());
});
