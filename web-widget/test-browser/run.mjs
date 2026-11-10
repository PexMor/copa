// Real-browser checks (Chromium via Playwright). Run `yarn build` first.
//   yarn test:browser
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const dist = (f) => readFileSync(fileURLToPath(new URL(`../dist/${f}`, import.meta.url)));

const config = {
  version: 1,
  endpoints: [{ id: 'main', url: 'https://copa.test', namespace: 'team', auth: { method: 'static-token', token: 'tok' } }],
};

// Host page with aggressively hostile global styles and a themed accent colour.
const page = (extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<style>
  button { background: rgb(255, 0, 0) !important; color: rgb(0, 255, 0) !important; border: 7px solid rgb(0, 0, 255) !important;
           padding: 40px !important; font-size: 40px !important; border-radius: 0 !important; }
  textarea, input, select { background: yellow !important; border: 9px dotted red !important; height: 300px !important; }
  div, section, p { margin: 33px !important; }
  ${extra}
</style></head><body>
<button id="host-button">host button</button>
<copa-share><script type="application/json">${JSON.stringify(config)}</script></copa-share>
<script src="/copa-widget.iife.js"></script>
</body></html>`;

function serve(html) {
  const srv = createServer((req, res) => {
    if (req.url === '/copa-widget.iife.js') { res.setHeader('content-type', 'text/javascript'); res.end(dist('copa-widget.iife.js')); }
    else { res.setHeader('content-type', 'text/html'); res.end(html); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

async function withPage(html, fn) {
  const srv = await serve(html);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    // Fake copa server for https://copa.test
    await p.route('https://copa.test/**', (route) => {
      const url = new URL(route.request().url());
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
      if (url.pathname === '/api/capabilities') return json({ history: true, history_limit: 20, item_ttl_secs: 3600, files: true, max_file_size: 1048576, size_limit: 4096, read: true, write: true });
      if (url.pathname === '/api/history') return json([]);
      return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"nf"}' });
    });
    await p.goto(`http://127.0.0.1:${srv.address().port}/`);
    await p.waitForSelector('copa-share >> [data-action="push"]');
    await fn(p, ctx, browser);
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    srv.close();
  }
}

const style = (p, selector, props) => p.evaluate(({ selector, props }) => {
  const el = document.querySelector('copa-share').shadowRoot.querySelector(selector);
  const cs = getComputedStyle(el);
  return Object.fromEntries(props.map((k) => [k, cs.getPropertyValue(k)]));
}, { selector, props });

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed++; console.error(`✗ ${name}\n  ${e.stack ?? e}`); }
}

await test('host button/input styles do not alter the widget (Shadow DOM isolation)', async () => {
  await withPage(page(), async (p) => {
    const pull = await style(p, '[data-action="pull"]', ['padding-top', 'border-top-width', 'font-size', 'background-color', 'color']);
    assert.notEqual(pull['padding-top'], '40px');
    assert.notEqual(pull['border-top-width'], '7px');
    assert.notEqual(pull['font-size'], '40px');
    assert.notEqual(pull['background-color'], 'rgb(255, 0, 0)');
    assert.notEqual(pull['color'], 'rgb(0, 255, 0)');
    assert.equal(pull['padding-top'], '5px'); // the widget's own value
    const ta = await style(p, 'textarea', ['height', 'border-top-width', 'background-color']);
    assert.notEqual(ta['height'], '300px');
    assert.notEqual(ta['border-top-width'], '9px');
    assert.notEqual(ta['background-color'], 'rgb(255, 255, 0)');
    // and the host's own button keeps the host's style (the widget does not leak out)
    const host = await p.evaluate(() => getComputedStyle(document.getElementById('host-button')).paddingTop);
    assert.equal(host, '40px');
  });
});

await test('the host sets the accent colour through a CSS custom property', async () => {
  await withPage(page('copa-share { --copa-accent: rgb(255, 0, 170); }'), async (p) => {
    const push = await style(p, '[data-action="push"]', ['background-color', 'border-top-color']);
    assert.equal(push['background-color'], 'rgb(255, 0, 170)');
    assert.equal(push['border-top-color'], 'rgb(255, 0, 170)');
  });
});

await test('default accent applies when the host sets nothing', async () => {
  await withPage(page(), async (p) => {
    const push = await style(p, '[data-action="push"]', ['background-color']);
    assert.equal(push['background-color'], 'rgb(37, 99, 235)');
  });
});

await test('theme attribute: dark vs light vs auto follows the OS', async () => {
  const dark = page().replace('<copa-share>', '<copa-share theme="dark">');
  await withPage(dark, async (p) => {
    assert.equal((await style(p, '.copa-share', ['background-color']))['background-color'], 'rgb(13, 17, 23)');
  });
  const light = page().replace('<copa-share>', '<copa-share theme="light">');
  await withPage(light, async (p) => {
    assert.equal((await style(p, '.copa-share', ['background-color']))['background-color'], 'rgb(255, 255, 255)');
  });
  const auto = page().replace('<copa-share>', '<copa-share theme="auto">');
  const srv = await serve(auto);
  const browser = await chromium.launch();
  try {
    for (const [scheme, expected] of [['dark', 'rgb(13, 17, 23)'], ['light', 'rgb(255, 255, 255)']]) {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const p = await ctx.newPage();
      await p.route('https://copa.test/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"history":false,"files":false}' }));
      await p.goto(`http://127.0.0.1:${srv.address().port}/`);
      await p.waitForSelector('copa-share >> [data-action="push"]');
      assert.equal((await style(p, '.copa-share', ['background-color']))['background-color'], expected, `auto + ${scheme}`);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});

await test('host can theme the dark scheme too (custom property beats the dark default)', async () => {
  const html = page('copa-share { --copa-bg: rgb(10, 20, 30); }').replace('<copa-share>', '<copa-share theme="dark">');
  await withPage(html, async (p) => {
    assert.equal((await style(p, '.copa-share', ['background-color']))['background-color'], 'rgb(10, 20, 30)');
  });
});

process.exit(failed ? 1 : 0);
