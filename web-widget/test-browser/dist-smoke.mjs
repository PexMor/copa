// Serves the built distribution (bin/frontend) with the built copasrv (bin/<arch>/copasrv --static-dir)
// and loads the widget demo from it in a real browser.   yarn test:dist   (after `make dist`)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ARCH = process.env.ARCH ?? 'x86_64';
const BIN = join(ROOT, 'bin', ARCH, 'copasrv');
const FRONTEND = join(ROOT, 'bin', 'frontend');
if (!existsSync(BIN) || !existsSync(join(FRONTEND, 'widget', 'dist'))) { console.error('run `make dist` first'); process.exit(2); }

const port = await new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = mkdtempSync(join(tmpdir(), 'copa-dist-'));
writeFileSync(join(tmp, 'c.toml'), `[server.namespaces.default]\nrw_token = "t"\n[server.pairing]\nenabled = true\nstate_dir = "${tmp}"\n`);
const srv = spawn(BIN, ['--config', join(tmp, 'c.toml'), '--port', String(port), '--bind', '127.0.0.1', '--static-dir', FRONTEND], { stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.error('✗', name, '\n   ', e.message); } };

try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/version`)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 50)); }

  await check('the web app is still served at /', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<html/i);
  });

  await check('every built widget file is served from /widget/', async () => {
    const files = readdirSync(join(FRONTEND, 'widget', 'dist'));
    assert.ok(files.includes('copa-widget.iife.js') && files.includes('copa-widget.es.js'), files.join());
    assert.ok(files.some((f) => f.startsWith('pairing-')) && files.some((f) => f.startsWith('oauth2-')), 'lazy chunks present');
    for (const f of files) assert.equal((await fetch(`${base}/widget/dist/${f}`)).status, 200, f);
    for (const p of ['demo/index.html', 'demo/oauth.html', 'demo/pair.html', 'schema/copa-widget.schema.json']) {
      assert.equal((await fetch(`${base}/widget/${p}`)).status, 200, p);
    }
    const schema = await (await fetch(`${base}/widget/schema/copa-widget.schema.json`)).json();
    assert.equal(schema.title, 'copa widget configuration');
  });

  const browser = await chromium.launch();
  try {
    await check('the pairing demo loads from the server, including its lazily loaded chunk', async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const chunks = [];
      page.on('response', (r) => { if (/\/widget\/dist\/.*\.js$/.test(r.url())) chunks.push(r.url().split('/').pop()); });
      await page.goto(`${base}/widget/demo/pair.html?copa=${encodeURIComponent(base)}&protocol=spake2`);
      await page.waitForSelector('copa-share >> [data-role="pair-input"]');
      assert.deepEqual(errors, []);
      assert.ok(chunks.includes('copa-widget.iife.js'));
      await page.close();
    });

    await check('the static-token demo connects to the same server (no CORS needed)', async () => {
      const page = await browser.newPage();
      await page.goto(`${base}/widget/demo/index.html?url=${encodeURIComponent(base)}&token=t`);
      await page.waitForSelector('copa-share >> [data-action="push"]');
      await page.close();
    });
  } finally { await browser.close(); }
} finally {
  srv.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : '\nOK: the distribution serves and runs the widget');
process.exit(failed ? 1 : 0);
