// Size budgets for the built widget (run `yarn build` first):  yarn size
//
//  * the ES entry chunk must stay small and must NOT contain the OAuth2 or pairing code, so that
//    embedders using static tokens do not pay for sign-in or pairing (each lives in its own chunk,
//    and the QR generator is a third one loaded only when a pairing key is shown);
//  * the script-tag bundle inlines everything (a script tag cannot lazy-load chunks) and has its own budget.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const KB = 1024;
const budgets = {
  entry: 18 * KB,    // gzipped, dist/copa-widget.es.js
  oauth2: 8 * KB,    // gzipped, the lazy oauth2 chunk
  pairing: 22 * KB,  // gzipped, the lazy pairing chunk (includes the Ed25519 library)
  qrcode: 10 * KB,   // gzipped, the QR generator
  iife: 52 * KB,     // gzipped, dist/copa-widget.iife.js (everything inlined, includes preact)
};

const gz = (file) => gzipSync(readFileSync(dist + file)).length;
const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
const entry = 'copa-widget.es.js';
const chunks = files.filter((f) => f !== entry && f !== 'copa-widget.iife.js' && statSync(dist + f).isFile());
let failed = false;
const report = (name, size, budget) => {
  const ok = size <= budget;
  failed ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(28)} ${(size / KB).toFixed(1).padStart(6)} kB gz   (budget ${(budget / KB).toFixed(0)} kB)`);
};

report(entry, gz(entry), budgets.entry);

const oauthChunk = chunks.find((f) => readFileSync(dist + f, 'utf8').includes('copa-token-service'));
if (!oauthChunk) {
  console.log('✗ no separate chunk contains the OAuth2 code (is it still lazy-loaded?)');
  failed = true;
} else {
  report(oauthChunk, gz(oauthChunk), budgets.oauth2);
}

const pairingChunk = chunks.find((f) => readFileSync(dist + f, 'utf8').includes('copa-pair/v1'));
if (!pairingChunk) {
  console.log('✗ no separate chunk contains the pairing code (is it still lazy-loaded?)');
  failed = true;
} else {
  report(pairingChunk, gz(pairingChunk), budgets.pairing);
}
const qrChunk = chunks.find((f) => f !== oauthChunk && f !== pairingChunk && readFileSync(dist + f, 'utf8').includes('QR Code'));
if (qrChunk) report(qrChunk, gz(qrChunk), budgets.qrcode);

const entrySource = readFileSync(dist + entry, 'utf8');
for (const marker of ['copa-token-service', 'copa_login_code', 'copa-login', 'copa-pair/v1', 'SPAKE2 pw']) {
  const leaked = entrySource.includes(marker);
  failed ||= leaked;
  console.log(`${leaked ? '✗' : '✓'} entry chunk does not contain sign-in/pairing code (${marker})`);
}
for (const name of ['oauth2', 'pairing']) {
  if (!new RegExp(`import\\(["'\`]\\./[^"'\`]*${name}`).test(entrySource)) {
    console.log(`✗ the entry chunk does not lazy-load the ${name} chunk`);
    failed = true;
  }
}

report('copa-widget.iife.js', gz('copa-widget.iife.js'), budgets.iife);
process.exit(failed ? 1 : 0);
