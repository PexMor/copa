// Real browser + real copasrv + real `copacli pair` (operator) + fake object store.
//
//   cargo build                      # copasrv and copacli, in the copa repo root
//   yarn build && yarn test:e2e:pairing   # in web-widget/ (needs Playwright's Chromium)
//
// Both pairing modes: a short SPAKE2 code, and an ECDH key exchange the operator approves by fingerprint.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const WIDGET = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT = resolve(WIDGET, '..');
const COPASRV = process.env.COPASRV ?? join(ROOT, 'target', 'debug', 'copasrv');
const COPACLI = process.env.COPACLI ?? join(ROOT, 'target', 'debug', 'copacli');
for (const [what, path] of [['copasrv', COPASRV], ['copacli', COPACLI], ['the built widget', join(WIDGET, 'dist', 'copa-widget.iife.js')]]) {
  if (!existsSync(path)) { console.error(`${what} not found at ${path}: build it first`); process.exit(2); }
}

const STATIC = 'static-operator-token';
const children = [];
const cleanups = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function until(fn, ms = 8000, what = 'condition') {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

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
      if (req.method === 'HEAD') { const o = objects.get(key); res.writeHead(o ? 200 : 404, { ...cors, ...(o ? { 'Content-Length': String(o.length) } : {}) }); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204, cors); return res.end(); }
      if (req.method === 'GET' && key === '') {
        const c = [...objects].map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>&quot;e&quot;</ETag><Size>${v.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
        res.writeHead(200, { ...cors, 'Content-Type': 'application/xml' });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix>copa/</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${c}</ListBucketResult>`);
      }
      const o = objects.get(key); res.writeHead(o ? 200 : 404, cors); res.end(o ?? '');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { cleanups.push(() => srv.close()); r({ url: `http://127.0.0.1:${srv.address().port}`, objects }); }));
}

function startHost() {
  const types = { '.html': 'text/html', '.js': 'text/javascript' };
  const srv = createServer((req, res) => {
    const path = normalize(join(WIDGET, new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(WIDGET)) { res.writeHead(403); return res.end(); }
    try { const b = readFileSync(path); res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }); res.end(b); } catch { res.writeHead(404); res.end('nf'); }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { cleanups.push(() => srv.close()); r(`http://localhost:${srv.address().port}`); }));
}

let failed = 0;
async function scenario(name, fn) {
  const t = Date.now();
  try { await fn(); console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { failed++; console.error(`✗ ${name}\n    ${String(e.stack ?? e).split('\n').slice(0, 6).join('\n    ')}`); }
}

const main = async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'copa-pair-e2e-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const [s3, host, port] = await Promise.all([startFakeS3(), startHost(), freePort()]);
  const copa = `http://127.0.0.1:${port}`;
  writeFileSync(join(tmp, 'copasrv.toml'), `
[server.namespaces.default]
rw_token = "${STATIC}"
[server.storage]
public_url = "${s3.url}"
bucket = "bucket"
access_key_id = "GKtest"
secret_access_key = "secret"
[server.pairing]
enabled = true
state_dir = "${tmp}"
device_ttl_secs = 3600
rate_limit = 1000
`);
  const srv = spawn(COPASRV, ['--config', join(tmp, 'copasrv.toml'), '--port', String(port), '--bind', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let srvLog = '';
  srv.stderr.on('data', (d) => { srvLog += d; });
  children.push(srv);
  await until(async () => (await fetch(`${copa}/api/version`)).ok, 15000, 'copasrv');

  /** The operator, using the real CLI. */
  const cli = (...args) => {
    const r = spawnSync(COPACLI, ['pair', '--server', copa, '--token', STATIC, '--namespace', 'default', ...args], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
    if (r.status !== 0) throw new Error(`copacli pair ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
  const openWindow = (access = 'rw', name = 'browser') => JSON.parse(cli('open', '--access', access, '--name', name, '--json'));
  const clipboard = async () => (await fetch(`${copa}/api/clipboard`, { headers: { Authorization: `Bearer ${STATIC}`, 'X-Copa-Namespace': 'default' } })).text();

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  async function open(protocol, extra = {}) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${host}/demo/pair.html?` + new URLSearchParams({ copa, protocol, ...extra }));
    await page.waitForSelector('copa-share >> [data-role="pair-input"]');
    return { ctx, page, errors, close: () => ctx.close() };
  }
  const ready = (page) => page.waitForSelector('copa-share >> [data-action="push"]', { timeout: 10000 });
  const pairWith = async (page, text) => { await page.fill('copa-share >> [data-role="pair-input"]', text); await page.click('copa-share >> [data-action="pair"]'); };
  const log = (page) => page.locator('#log').textContent();

  await scenario('SPAKE2: the operator opens a window with the CLI, the user types the code, then share text and a file', async () => {
    const { page, errors, close } = await open('spake2');
    assert.equal(await page.locator('copa-share >> [data-action="sign-in"]').count(), 0);
    const w = openWindow('rw', 'e2e browser');
    await pairWith(page, w.display_code);
    await ready(page);
    assert.match(await log(page), /auth: ready/);

    await page.fill('copa-share >> textarea', 'hello from a paired browser');
    await page.click('copa-share >> [data-action="push"]');
    await page.waitForSelector('copa-share >> [role="status"]');
    assert.equal(await clipboard(), 'hello from a paired browser');

    await page.setInputFiles('copa-share >> input[type="file"]', { name: 'paired.txt', mimeType: 'text/plain', buffer: Buffer.from('file via pairing') });
    await page.waitForSelector('copa-share >> li[data-kind="file"]', { timeout: 10000 });
    assert.ok([...s3.objects.values()].some((b) => b.toString() === 'file via pairing'));

    assert.match(cli('devices'), /e2e browser/);
    assert.deepEqual(errors, []);
    await close();
  });

  await scenario('SPAKE2: a wrong code is refused with a generic message; the window survives a few mistakes', async () => {
    const { page, close } = await open('spake2');
    const w = openWindow();
    await pairWith(page, `${w.window_id}-${w.code === '11111111' ? '22222222' : '11111111'}`);
    await page.waitForSelector('copa-share >> [data-role="pairing-error"]');
    assert.match(await page.locator('copa-share >> [data-role="pairing-error"]').textContent(), /Pairing failed/);
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0);
    await pairWith(page, w.display_code);
    await ready(page);
    await close();
  });

  await scenario('SPAKE2: a code works once', async () => {
    const w = openWindow();
    const a = await open('spake2');
    await pairWith(a.page, w.display_code);
    await ready(a.page);
    const b = await open('spake2');
    await pairWith(b.page, w.display_code);
    await b.page.waitForSelector('copa-share >> [data-role="pairing-error"]');
    assert.equal(await b.page.locator('copa-share >> [data-action="push"]').count(), 0);
    await a.close(); await b.close();
  });

  await scenario('ECDH: the page shows a fingerprint and a QR; the operator approves by the digits with the CLI', async () => {
    const { page, errors, close } = await open('ecdh');
    const w = openWindow('rw', 'ecdh browser');
    await pairWith(page, w.window_id);
    await page.waitForSelector('copa-share >> [data-role="fingerprint"]');
    const fp = (await page.locator('copa-share >> [data-role="fingerprint"]').textContent()).trim();
    assert.match(fp, /^\d{4} \d{4} \d{4} \d{4}$/);
    await page.waitForSelector('copa-share >> [data-role="qr"] svg');
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0, 'nothing is shared before the operator decides');

    assert.ok(cli('pending').includes(fp), 'the operator sees the same digits');
    assert.match(cli('approve', fp), /approved/);
    await ready(page);
    await page.fill('copa-share >> textarea', 'approved by fingerprint');
    await page.click('copa-share >> [data-action="push"]');
    await until(async () => (await clipboard()) === 'approved by fingerprint', 5000, 'push after ECDH pairing');
    await page.setInputFiles('copa-share >> input[type="file"]', { name: 'ecdh.txt', mimeType: 'text/plain', buffer: Buffer.from('file via ecdh') });
    await page.waitForSelector('copa-share >> li[data-kind="file"]', { timeout: 10000 });
    assert.deepEqual(errors, []);
    await close();
  });

  await scenario('ECDH: a rejected device is told so and gets nothing', async () => {
    const { page, close } = await open('ecdh');
    const w = openWindow();
    await pairWith(page, w.display_code);
    await page.waitForSelector('copa-share >> [data-role="fingerprint"]');
    const fp = (await page.locator('copa-share >> [data-role="fingerprint"]').textContent()).trim();
    assert.match(cli('reject', fp), /rejected/);
    await page.waitForSelector('copa-share >> [data-role="pairing-error"]');
    assert.match(await page.locator('copa-share >> [data-role="pairing-error"]').textContent(), /rejected/);
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0);
    await close();
  });

  await scenario('ECDH: Cancel in the page stops the wait', async () => {
    const { page, close } = await open('ecdh');
    const w = openWindow();
    await pairWith(page, w.window_id);
    await page.waitForSelector('copa-share >> [data-action="cancel-pairing"]');
    await page.click('copa-share >> [data-action="cancel-pairing"]');
    await page.waitForSelector('copa-share >> [data-role="pairing-error"][data-code="cancelled"]');
    await close();
  });

  await scenario('revoking the device with the CLI unpairs the browser, which can pair again', async () => {
    const { page, close } = await open('spake2');
    const w = openWindow('rw', 'to revoke');
    await pairWith(page, w.display_code);
    await ready(page);
    const dev = JSON.parse(cli('devices', '--json')).find((d) => d.name === 'to revoke' && !d.revoked);
    assert.match(cli('revoke', dev.dev), /revoked/);
    await page.click('copa-share >> [data-action="refresh"]');                        // any request reveals it
    await page.waitForSelector('copa-share >> [data-role="pairing-ended"]', { timeout: 10000 });
    assert.equal(await page.locator('copa-share >> [data-action="push"]').count(), 0);
    assert.match(await log(page), /auth: expired/);
    const w2 = openWindow();
    await pairWith(page, w2.display_code);
    await ready(page);
    await close();
  });

  await scenario('persist=session: a reload keeps the pairing', async () => {
    const { page, close } = await open('spake2', { persist: 'session' });
    await pairWith(page, openWindow().display_code);
    await ready(page);
    await page.reload();
    await ready(page);
    assert.equal(await page.locator('copa-share >> [data-role="pair-input"]').count(), 0);
    await close();
  });

  await scenario('the server log never contains a code, key or credential', async () => {
    assert.ok(/pair: window opened/.test(srvLog) && /enrolled/.test(srvLog));
    assert.ok(!/v1\.[A-Za-z0-9_-]{20,}\./.test(srvLog), 'no device token in the log');
    assert.ok(!/Bearer /i.test(srvLog));
  });
};

try { await main(); } catch (e) { failed++; console.error('fatal:', e); }
finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* ignore */ } }
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  await sleep(300);
}
console.log(failed ? `\n${failed} FAILED` : '\nOK: both pairing modes work end to end in a real browser');
process.exit(failed ? 1 : 0);
