// Follows the steps documented in docs/WIDGET.md against a running copasrv:
//   COPA_URL=http://127.0.0.1:8080 COPA_TOKEN=… yarn test:demo
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';

const { COPA_URL, COPA_TOKEN } = process.env;
if (!COPA_URL || !COPA_TOKEN) { console.log('skipped: set COPA_URL and COPA_TOKEN'); process.exit(0); }

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const srv = createServer(async (req, res) => {
  const path = normalize(join(root, new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try { const body = await readFile(path); res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream'); res.end(body); }
  catch { res.statusCode = 404; res.end('not found'); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const demo = `http://127.0.0.1:${srv.address().port}/demo/index.html`;

const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${demo}?url=${encodeURIComponent(COPA_URL)}&token=${encodeURIComponent(COPA_TOKEN)}`);
  await page.waitForSelector('copa-share >> [data-action="push"]', { timeout: 10000 });
  console.log('✓ widget rendered from the script tag and connected');

  const text = `demo-${Date.now()}`;
  await page.fill('copa-share >> textarea', text);
  await page.click('copa-share >> [data-action="push"]');
  await page.waitForSelector('copa-share >> [role="status"]');
  const res = await fetch(`${COPA_URL}/api/clipboard`, { headers: { Authorization: `Bearer ${COPA_TOKEN}` } });
  assert.equal(await res.text(), text);
  console.log('✓ pushed text arrived on the server');

  await page.click('copa-share >> [data-action="pull"]');
  await page.waitForFunction((t) => document.querySelector('copa-share').shadowRoot.querySelector('textarea').value === t, text);
  console.log('✓ pull returns it');
  assert.deepEqual(errors, []);
} catch (e) {
  failed = true;
  console.error('✗', e.stack ?? e);
} finally {
  await browser.close();
  srv.close();
}
process.exit(failed ? 1 : 0);
