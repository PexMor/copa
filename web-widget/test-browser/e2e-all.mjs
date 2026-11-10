// Every sign-in method on one demo page, sharing text, an image and a PDF through a real S3 backend (Garage).
//
//   make dist                                   # builds bin/<arch>/copasrv and bin/frontend (incl. the widget)
//   COPA_CORS_ORIGINS="http://127.0.0.1:18791 http://localhost:18791" make s3-up
//   yarn test:e2e:all                           # in web-widget/ (needs uv, Playwright's Chromium, copacli built)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ARCH = process.env.ARCH ?? 'x86_64';
const COPASRV = join(ROOT, 'bin', ARCH, 'copasrv');
const COPACLI = join(ROOT, 'target', 'debug', 'copacli');
const FRONTEND = join(ROOT, 'bin', 'frontend');
const STORAGE = join(ROOT, 'deploy', 'garage', 'storage.toml');
for (const [what, p] of [['copasrv (make dist)', COPASRV], ['copacli (cargo build)', COPACLI], ['bin/frontend (make dist)', join(FRONTEND, 'widget')], ['Garage storage block (make s3-up)', STORAGE]]) {
  if (!existsSync(p)) { console.error(`missing: ${what} at ${p}`); process.exit(2); }
}
const PORT = Number(process.env.COPA_E2E_PORT ?? 18791);   // must match COPA_CORS_ORIGINS given to `make s3-up`
const copa = `http://127.0.0.1:${PORT}`;
const STATIC = 'shared-static-token';
const NS = 'shared';

const children = [];
const cleanups = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function until(fn, ms = 8000, what = 'condition') {
  const t = Date.now();
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}

// ── things to share ─────────────────────────────────────────────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'copa-all-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  // token service
  const issuerPort = await freePort();
  const issuer = `http://127.0.0.1:${issuerPort}`;
  children.push(spawn('uv', ['run', 'token-issuer', '--ephemeral', '--port', String(issuerPort), '--log-level', 'warning'], { cwd: join(ROOT, 'token-issuer'), stdio: 'ignore' }));
  await until(async () => (await fetch(`${issuer}/healthz`)).ok, 20000, 'token issuer');

  // copasrv: static + trusted issuer (from the documented example) + pairing + Garage
  const lines = readFileSync(join(ROOT, 'config.toml.example'), 'utf8').split('\n');
  const block = lines.slice(lines.indexOf('# >>> issuers') + 1, lines.indexOf('# <<< issuers'))
    .map((l) => (l.startsWith('# ') ? l.slice(2) : l.replace(/^#/, ''))).join('\n')
    .replaceAll('https://auth.example.com/jwks.json', `${issuer}/jwks.json`).replaceAll('https://auth.example.com', issuer)
    .replaceAll('https://copa.example.com', copa).replaceAll('copa:shared:rw', 'copa:team:rw').replace('leeway_secs = 30', 'leeway_secs = 0\njwks_min_refresh_secs = 1');
  writeFileSync(join(tmp, 'copasrv.toml'), `
[server.namespaces.default]
rw_token = "unused-default-token"
[server.namespaces.${NS}]
rw_token = "${STATIC}"
${readFileSync(STORAGE, 'utf8')}
[server.pairing]
enabled = true
state_dir = "${tmp}"
rate_limit = 1000
${block}
`);
  let srvLog = '';
  const srv = spawn(COPASRV, ['--config', join(tmp, 'copasrv.toml'), '--port', String(PORT), '--bind', '127.0.0.1', '--static-dir', FRONTEND], { stdio: ['ignore', 'ignore', 'pipe'] });
  srv.stderr.on('data', (d) => { srvLog += d; });
  children.push(srv);
  await until(async () => (await fetch(`${copa}/api/version`)).ok, 15000, 'copasrv');
  assert.match(srvLog, /files: enabled/, 'copasrv is using the Garage storage');

  const api = (method, path, body) => fetch(`${copa}${path}`, { method, headers: { Authorization: `Bearer ${STATIC}`, 'X-Copa-Namespace': NS, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const clipboard = async () => (await (await api('GET', '/api/clipboard')).text());
  const cli = (...args) => {
    const r = spawnSync(COPACLI, ['pair', '--server', copa, '--token', STATIC, '--namespace', NS, ...args], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
    if (r.status !== 0) throw new Error(`copacli pair ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };

  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${copa}/widget/demo/all.html?` + new URLSearchParams({ copa, ns: NS, token: STATIC, issuer }));
  await page.waitForSelector('copa-share >> select#copa-endpoint');

  const w = (sel) => `copa-share >> ${sel}`;
  const choose = async (id) => { await page.selectOption(w('select#copa-endpoint'), id); await sleep(100); };
  const log = () => page.locator('#log').textContent();

  /** Share text, an image and a PDF with the widget and prove what reached Garage. */
  async function shareThings(tag) {
    const text = `text via ${tag}`;
    await page.fill(w('textarea'), text);
    await page.click(w('[data-action="push"]'));
    await until(async () => (await clipboard()) === text, 8000, `${tag}: text on the server`);

    await page.setInputFiles(w('input[type="file"]'), { name: `pic-${tag}.png`, mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector(w(`li[data-kind="file"]:has-text("pic-${tag}.png")`), { timeout: 15000 });
    await page.setInputFiles(w('input[type="file"]'), { name: `doc-${tag}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    await page.waitForSelector(w(`li[data-kind="file"]:has-text("doc-${tag}.pdf")`), { timeout: 15000 });

    // the PNG is shown as a thumbnail loaded from Garage through a fresh presigned URL
    await page.waitForFunction((name) => {
      const li = [...document.querySelector('copa-share').shadowRoot.querySelectorAll('li[data-kind="file"]')].find((l) => l.textContent.includes(name));
      const img = li?.querySelector('img.copa-thumb');
      return img && img.complete && img.naturalWidth > 0;
    }, `pic-${tag}.png`, { timeout: 15000 });

    // and the stored bytes are exactly what was shared (downloaded straight from Garage)
    const items = await (await api('GET', '/api/history')).json();
    for (const [name, bytes] of [[`pic-${tag}.png`, PNG], [`doc-${tag}.pdf`, PDF]]) {
      const item = items.find((i) => i.name === name);
      assert.ok(item, `${name} is in the history`);
      assert.equal(item.size, bytes.length);
      const dl = await (await api('GET', `/api/files/${item.id}`)).json();
      assert.ok(dl.download_url.startsWith('http://127.0.0.1:3900/'), 'a presigned Garage URL');
      const got = Buffer.from(await (await fetch(dl.download_url)).arrayBuffer());
      assert.equal(sha(got), sha(bytes), `${name}: the object in Garage is byte-identical`);
    }
  }

  let failed = 0;
  async function scenario(name, fn) {
    const t = Date.now();
    try { await fn(); console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
    catch (e) { failed++; console.error(`✗ ${name}\n    ${String(e.stack ?? e).split('\n').slice(0, 7).join('\n    ')}`); }
  }
  const ready = () => page.waitForSelector(w('[data-action="push"]'), { timeout: 15000 });

  await scenario('static token', async () => {
    await choose('static');
    await ready();
    await shareThings('static');
  });

  await scenario('token service pop-up (sign in as alice)', async () => {
    await choose('sso');
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click(w('[data-action="sign-in"]'))]);
    await popup.waitForSelector('select#user');
    await popup.fill('#password', 'alice');
    await popup.click('button[value="signin"]');
    await ready();
    await shareThings('sso');
  });

  await scenario('pairing with a short code (SPAKE2)', async () => {
    await choose('code');
    const win = JSON.parse(cli('open', '--name', 'all-methods code', '--json'));
    await page.fill(w('[data-role="pair-input"]'), win.display_code);
    await page.click(w('[data-action="pair"]'));
    await ready();
    await shareThings('code');
  });

  await scenario('pairing by key exchange the operator approves (ECDH)', async () => {
    await choose('key');
    const win = JSON.parse(cli('open', '--name', 'all-methods key', '--json'));
    await page.fill(w('[data-role="pair-input"]'), win.window_id);
    await page.click(w('[data-action="pair"]'));
    await page.waitForSelector(w('[data-role="fingerprint"]'));
    const fp = (await page.locator(w('[data-role="fingerprint"]')).textContent()).trim();
    cli('approve', fp);
    await ready();
    await shareThings('key');
  });

  await scenario('everything shared by one method is visible from the others (same namespace, live)', async () => {
    await choose('static');
    await ready();
    for (const tag of ['sso', 'code', 'key']) {
      await page.waitForSelector(w(`li[data-kind="file"]:has-text("pic-${tag}.png")`), { timeout: 10000 });
    }
    assert.match(await log(), /auth static: ready/);
    assert.match(await log(), /auth sso: ready/);
  });

  await scenario('no page errors, and the server log holds no credential', async () => {
    assert.deepEqual(pageErrors, []);
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(srvLog) && !/Bearer /i.test(srvLog) && !srvLog.includes(STATIC), 'no secrets in the log');
    assert.ok(!srvLog.includes('375ba50f') && !/secret_access_key/.test(srvLog), 'no storage credentials in the log');
  });

  return failed;
}

let failed = 1;
try { failed = await main(); } catch (e) { console.error('fatal:', e); }
finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* ignore */ } }
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  await sleep(300);
}
console.log(failed ? `\n${failed} FAILED` : '\nOK: all four methods share text, an image and a PDF through Garage');
process.exit(failed ? 1 : 0);
