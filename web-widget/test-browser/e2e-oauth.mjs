// Real browser, real copasrv, real token issuer(s), fake object store.
//
//   cargo build                    # in the copa repo root (builds target/debug/copasrv)
//   yarn build && yarn test:e2e    # in web-widget/   (needs uv and Playwright's Chromium)
//
// Exercises: popup sign-in, push text, upload a file, live updates, silent token renewal,
// sign-out, an expired refresh token, a pop-up whose opener was cut by COOP (poll fallback),
// the full-page redirect flow, a blocked pop-up, and tokens copasrv must refuse.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WIDGET = resolve(HERE, '..');
const ROOT = resolve(WIDGET, '..');                         // the copa repo
const COPASRV = process.env.COPASRV ?? join(ROOT, 'target', 'debug', 'copasrv');
if (!existsSync(COPASRV)) { console.error(`${COPASRV} not found: run \`cargo build\` in the copa repo first`); process.exit(2); }
if (!existsSync(join(WIDGET, 'dist', 'copa-widget.iife.js'))) { console.error('run `yarn build` first'); process.exit(2); }

const AUD = 'https://copa.example.com';
const ADMIN = 'adm-e2e';
const children = [];
const cleanups = [];

const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function start(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  let err = '';
  c.stderr.on('data', (d) => { err += d; });
  c.errOutput = () => err;
  children.push(c);
  return c;
}

async function startIssuer(extra = []) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const c = start('uv', ['run', 'token-issuer', '--ephemeral', '--port', String(port), '--admin-token', ADMIN, '--log-level', 'warning', ...extra],
    { cwd: join(ROOT, 'token-issuer') });
  await until(async () => (await fetch(`${url}/healthz`)).ok, 20000, 'token issuer');
  const admin = (path, body = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify(body) });
  return { url, c, setFaults: (...f) => admin('/admin/faults', { faults: f }) };
}

// ── fake object store (path style, no signature checks, CORS for the browser) ──────────────────────
function startFakeS3() {
  const objects = new Map();
  const srv = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, GET, HEAD, DELETE', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/bucket\/?/, ''));
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200, cors); return res.end(); }
      if (req.method === 'HEAD') {
        const o = objects.get(key);
        res.writeHead(o ? 200 : 404, { ...cors, ...(o ? { 'Content-Length': String(o.length) } : {}) });
        return res.end();
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204, cors); return res.end(); }
      if (req.method === 'GET' && key === '') {
        const contents = [...objects].map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag><Size>${v.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>copa/</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      }
      const o = objects.get(key);
      res.writeHead(o ? 200 : 404, cors); res.end(o ?? '');
    });
  });
  return new Promise((resolveP) => srv.listen(0, '127.0.0.1', () => {
    cleanups.push(() => srv.close());
    resolveP({ url: `http://127.0.0.1:${srv.address().port}`, objects });
  }));
}

// ── static server for the host pages ──────────────────────────────────────────────────────────────────
function startHostServer() {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const srv = createServer((req, res) => {
    const path = normalize(join(WIDGET, new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(WIDGET)) { res.writeHead(403); return res.end(); }
    try { const b = readFileSync(path); res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }); res.end(b); }
    catch { res.writeHead(404); res.end('nf'); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { cleanups.push(() => srv.close()); r(`http://localhost:${srv.address().port}`); }));
}

function issuersBlock(name, issuerUrl, audience) {
  const lines = readFileSync(join(ROOT, 'config.toml.example'), 'utf8').split('\n');
  const begin = lines.indexOf('# >>> issuers') + 1;
  const end = lines.indexOf('# <<< issuers');
  return lines.slice(begin, end).map((l) => (l.startsWith('# ') ? l.slice(2) : l.replace(/^#/, '')))
    .join('\n')
    .replaceAll('server.auth.issuers.hub', `server.auth.issuers.${name}`)
    .replaceAll('https://auth.example.com/jwks.json', `${issuerUrl}/jwks.json`)
    .replaceAll('https://auth.example.com', issuerUrl)
    .replaceAll('https://copa.example.com', audience)   // this server's own address: what the widget asks for by default
    .replaceAll('copa:shared:rw', 'copa:team:rw')
    .replace('leeway_secs = 30', 'leeway_secs = 0\njwks_min_refresh_secs = 1');
}

// ── harness ──────────────────────────────────────────────────────────────────────────────────────────
let failed = 0;
let resetIssuers = async () => {};
async function scenario(name, fn) {
  const t = Date.now();
  try { await resetIssuers(); await fn(); console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.error(`✗ ${name}\n    ${String(e.stack ?? e).split('\n').slice(0, 6).join('\n    ')}`); }
}

const main = async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'copa-e2e-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  const [issuer, shortRefresh, s3, host] = await Promise.all([startIssuer(), startIssuer(['--refresh-ttl', '6']), startFakeS3(), startHostServer()]);
  resetIssuers = async () => { await issuer.setFaults(); await shortRefresh.setFaults(); };
  const copaPort = await freePort();
  const copa = `http://127.0.0.1:${copaPort}`;
  writeFileSync(join(tmp, 'copasrv.toml'), `
[server.namespaces.default]
rw_token = "static-e2e"
[server.namespaces.shared]
rw_token = "shared-static"
[server.storage]
public_url = "${s3.url}"
bucket = "bucket"
access_key_id = "GKtest"
secret_access_key = "secret"
${issuersBlock('hub', issuer.url, copa)}
${issuersBlock('short', shortRefresh.url, copa)}
`);
  const srv = start(COPASRV, ['--config', join(tmp, 'copasrv.toml'), '--port', String(copaPort), '--bind', '127.0.0.1']);
  await until(async () => (await fetch(`${copa}/api/version`)).ok, 15000, 'copasrv');

  const clipboard = async (ns = 'shared') => (await fetch(`${copa}/api/clipboard`, { headers: { Authorization: 'Bearer shared-static', 'X-Copa-Namespace': ns } })).text();
  const pageUrl = (extra = {}, file = 'oauth.html', iss = issuer) =>
    `${host}/demo/${file}?` + new URLSearchParams({ copa, issuer: iss.url, ns: 'shared', ...extra });

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());

  /** A fresh browser context + page with the widget loaded. */
  async function open(extra = {}, iss = issuer, init) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    if (init) await page.addInitScript(init);
    await page.goto(pageUrl(extra, 'oauth.html', iss));
    await page.waitForSelector('copa-share >> [data-action="sign-in"]');
    return { ctx, page, requests, errors, close: () => ctx.close() };
  }

  /** Click Sign in, complete the pop-up as `user`. */
  async function popupSignIn(ctx, page, user = 'alice') {
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('copa-share >> [data-action="sign-in"]')]);
    await popup.waitForSelector('select#user');
    await popup.selectOption('select#user', user);
    await popup.fill('#password', user);
    await popup.click('button[value="signin"]');
    return popup;
  }
  const ready = (page) => page.waitForSelector('copa-share >> [data-action="push"]', { timeout: 10000 });
  const state = (page) => page.locator('copa-share >> [data-role="auth-state"]').textContent();
  const log = (page) => page.locator('#log').textContent();

  // ────────────────────────────────────────────────────────────────────────────────────────────────
  await scenario('pop-up sign-in, push text, upload a file, live update from another device', async () => {
    const { ctx, page, errors, close } = await open();
    await popupSignIn(ctx, page);
    await ready(page);
    assert.match(await state(page), /ready/);

    await page.fill('copa-share >> textarea', 'hello from the browser');
    await page.click('copa-share >> [data-action="push"]');
    await page.waitForSelector('copa-share >> [role="status"]');
    assert.equal(await clipboard(), 'hello from the browser');

    await page.setInputFiles('copa-share >> input[type="file"]', { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') });
    await page.waitForSelector('copa-share >> li[data-kind="file"]', { timeout: 10000 });
    assert.match(await page.locator('copa-share >> li[data-kind="file"]').first().textContent(), /hello\.txt/);
    assert.deepEqual([...s3.objects.values()].map((b) => b.length), [11]);       // the bytes went straight to the object store

    await until(async () => (await page.locator('copa-share >> [data-role="live-state"]').getAttribute('data-state')) === 'live', 8000, 'live updates');
    await fetch(`${copa}/api/clipboard`, { method: 'POST', headers: { Authorization: 'Bearer shared-static', 'X-Copa-Namespace': 'shared' }, body: 'from another device' });
    await page.waitForFunction(() => document.querySelector('copa-share').shadowRoot.textContent.includes('from another device'), null, { timeout: 8000 });

    assert.match(await log(page), /auth: ready/);
    assert.deepEqual(errors, []);
    await close();
  });

  await scenario('the access token is renewed silently when it expires', async () => {
    await issuer.setFaults('short-ttl:3');                       // tokens that live 3 seconds (copasrv leeway is 0)
    const { ctx, page, requests, close } = await open();
    await popupSignIn(ctx, page);
    await ready(page);
    await page.fill('copa-share >> textarea', 'before expiry');
    await page.click('copa-share >> [data-action="push"]');
    await until(async () => (await clipboard()) === 'before expiry', 5000, 'first push');
    await sleep(3600);                                           // the first token is now expired at the server
    await page.fill('copa-share >> textarea', 'after expiry');
    await page.click('copa-share >> [data-action="push"]');
    await until(async () => (await clipboard()) === 'after expiry', 8000, 'push with a renewed token');
    assert.ok(requests.some((r) => r.startsWith('POST') && r.endsWith('/refresh')), 'the widget renewed the token');
    assert.match(await state(page), /ready/);
    await issuer.setFaults();
    await close();
  });

  await scenario('sign out ends the session; signing in again works', async () => {
    const { ctx, page, requests, close } = await open();
    await popupSignIn(ctx, page);
    await ready(page);
    await page.click('copa-share >> [data-action="sign-out"]');
    await page.waitForSelector('copa-share >> [data-action="sign-in"]');
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0);
    assert.ok(requests.some((r) => r.startsWith('POST') && r.endsWith('/logout')));
    await popupSignIn(ctx, page, 'bob');
    await page.waitForSelector('copa-share >> [data-action="pull"]');
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0, 'bob (copa-readers) is read-only');
    await close();
  });

  await scenario('a pop-up whose opener was cut (COOP) still signs in, through polling', async () => {
    await issuer.setFaults('coop');
    const { ctx, page, requests, close } = await open();
    const popup = await popupSignIn(ctx, page);
    await ready(page);
    assert.ok(requests.some((r) => r.startsWith('POST') && r.endsWith('/poll')), 'the widget polled for the result');
    assert.match(await state(page), /ready/);
    void popup;
    await issuer.setFaults();
    await close();
  });

  await scenario('cancelling in the pop-up is reported quietly', async () => {
    const { ctx, page, close } = await open();
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('copa-share >> [data-action="sign-in"]')]);
    await popup.waitForSelector('select#user');
    await popup.click('button[value="cancel"]');
    await page.waitForSelector('copa-share >> [data-role="sign-in-error"][data-code="cancelled"]');
    assert.equal(await page.locator('copa-share >> [data-role="sign-in-error"]').getAttribute('role'), 'status');
    await close();
  });

  await scenario('closing the pop-up without signing in is a cancellation', async () => {
    const { ctx, page, close } = await open();
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('copa-share >> [data-action="sign-in"]')]);
    await popup.waitForSelector('select#user');
    await popup.close();
    await page.waitForSelector('copa-share >> [data-role="sign-in-error"][data-code="cancelled"]', { timeout: 10000 });
    await close();
  });

  await scenario('a blocked pop-up is explained, and "Sign in on this page" completes through a redirect', async () => {
    const { ctx, page, close } = await open({}, issuer, () => { window.open = () => null; });
    await page.click('copa-share >> [data-action="sign-in"]');
    await page.waitForSelector('copa-share >> [data-role="sign-in-error"][data-code="popup-blocked"]');
    assert.match(await page.locator('copa-share >> [data-role="sign-in-error"]').textContent(), /pop-ups/i);
    await Promise.all([page.waitForURL(/\/login/), page.click('copa-share >> [data-action="sign-in-redirect"]')]);
    await page.waitForSelector('select#user');
    await page.fill('#password', 'alice');
    await Promise.all([page.waitForURL(/oauth\.html/), page.click('button[value="signin"]')]);
    await ready(page);
    assert.ok(!page.url().includes('copa_login_code'), 'the login code is removed from the address bar');
    assert.ok(!page.url().includes('#copa_login'), 'and so is the fragment');
    await close();
  });

  await scenario('flow=redirect signs in on the page without any pop-up', async () => {
    const { page, ctx, close } = await open({ flow: 'redirect' });
    let popups = 0;
    ctx.on('page', () => { popups++; });
    await Promise.all([page.waitForURL(/\/login/), page.click('copa-share >> [data-action="sign-in"]')]);
    await page.waitForSelector('select#user');
    await page.fill('#password', 'alice');
    await Promise.all([page.waitForURL(/oauth\.html/), page.click('button[value="signin"]')]);
    await ready(page);
    assert.equal(popups, 0);
    await close();
  });

  await scenario('a session persisted for the tab survives a reload', async () => {
    const { ctx, page, close } = await open({ persist: 'session' });
    await popupSignIn(ctx, page);
    await ready(page);
    await page.reload();
    await ready(page);                                           // restored from the stored refresh token, without signing in
    assert.match(await state(page), /ready/);
    await close();
  });

  for (const [fault, why] of [['wrong-audience', 'for another server'], ['unknown-kid', 'signed with an unknown key'], ['expired-token', 'already expired'], ['wrong-issuer', 'from an untrusted issuer'], ['bad-signature', 'with a bad signature'], ['alg-none', 'unsigned'], ['hs256-confusion', 'HS256-forged']]) {
    await scenario(`copasrv refuses a token ${why}, and the widget says so`, async () => {
      await issuer.setFaults(fault);
      const { ctx, page, close } = await open();
      await popupSignIn(ctx, page);
      await page.waitForSelector('copa-share >> [data-role="access-error"]', { timeout: 10000 });
      assert.match(await page.locator('copa-share >> [data-role="access-error"]').textContent(), /did not accept your sign-in|session expired/);
      assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0, 'no sharing controls with a refused token');
      // the user can get out of it
      await page.click('copa-share >> [data-action="sign-out"]');
      await page.waitForSelector('copa-share >> [data-action="sign-in"]');
      await issuer.setFaults();
      await close();
    });
  }

  await scenario('a user without access to the namespace is told so (403), not that the token is bad', async () => {
    const { ctx, page, close } = await open();
    await popupSignIn(ctx, page, 'carol');                         // valid token, no scope
    await page.waitForSelector('copa-share >> [data-role="access-error"]', { timeout: 10000 });
    assert.match(await page.locator('copa-share >> [data-role="access-error"]').textContent(), /no access to this namespace/);
    await close();
  });

  await scenario('when the refresh token expires too, the widget returns to signed-out', async () => {
    await shortRefresh.setFaults('short-ttl:2');                   // 2 s access tokens, refresh tokens die after 6 s
    const { ctx, page, close } = await open({}, shortRefresh);
    await popupSignIn(ctx, page);
    await ready(page);
    // refresh lifetimes slide with every rotation, so let the session go idle: no renewal gets through for 7 s
    await page.route('**/refresh', (r) => r.abort());
    await sleep(7000);
    await page.unroute('**/refresh');
    await page.waitForSelector('copa-share >> [data-action="sign-in"]', { timeout: 20000 });   // the next renewal is refused: expired
    assert.match(await state(page), /expired|signed-out/);
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0);
    await close();
  });

  const copaLog = srv.errOutput();
  await scenario('copasrv never logged a credential', async () => {
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(copaLog), 'no JWT in the server log');
    assert.ok(!/Bearer /i.test(copaLog));
    assert.ok(/token rejected/.test(copaLog), 'rejections are logged with their reason');
  });
};

try {
  await main();
} catch (e) {
  failed++;
  console.error('fatal:', e);
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* ignore */ } }
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  await sleep(300);
}
console.log(failed ? `\n${failed} FAILED` : '\nOK: popup, redirect, renewal, COOP polling and rejected tokens all behave');
process.exit(failed ? 1 : 0);
