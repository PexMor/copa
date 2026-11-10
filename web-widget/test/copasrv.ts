/** Starts the real copasrv binary (cargo build first) with pairing enabled, for cross-implementation tests. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = process.env.COPASRV ?? resolve(import.meta.dirname, '../../target/debug/copasrv');
export const hasCopasrv = existsSync(BIN);
export const STATIC = 'static-test-token';

export interface Copasrv {
  url: string;
  stop(): Promise<void>;
  api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }>;
  openWindow(access?: string, name?: string): Promise<{ window_id: string; code: string; display_code: string; expires_at: number }>;
  pending(): Promise<{ id: string; fingerprint: string; window_id: string }[]>;
  decide(id: string, verb: 'approve' | 'reject', body?: unknown): Promise<number>;
  devices(): Promise<{ dev: string; name: string; acc: string; revoked: boolean; exp: number }[]>;
  revoke(dev: string): Promise<number>;
  clipboard(token: string, method?: string, body?: string): Promise<number>;
  log(): string;
}

const freePort = () => new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

export async function startCopasrv(pairingExtra = ''): Promise<Copasrv> {
  const dir = mkdtempSync(join(tmpdir(), 'copa-pair-'));
  writeFileSync(join(dir, 'config.toml'),
    `[server.namespaces.default]\nrw_token = "${STATIC}"\n[server.pairing]\nenabled = true\nstate_dir = "${dir}"\n${pairingExtra}\n`);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let log = '';
  const child: ChildProcess = spawn(BIN, ['--config', join(dir, 'config.toml'), '--port', String(port), '--bind', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d) => { log += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; ; i++) {
    if (exited) throw new Error('copasrv exited early:\n' + log);
    try { if ((await fetch(`${url}/api/version`)).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error('copasrv did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  const api: Copasrv['api'] = async (method, path, body, token = STATIC) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'X-Copa-Namespace': 'default', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  return {
    url, api, log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await new Promise<void>((r) => { if (exited) r(); else child.on('exit', () => r()); });
      rmSync(dir, { recursive: true, force: true });
    },
    async openWindow(access = 'rw', name = 'test device') {
      const r = await api('POST', '/api/pair/windows', { access, name });
      if (r.status !== 200) throw new Error(`open window: ${r.status}`);
      return r.json;
    },
    async pending() { return (await api('GET', '/api/pair/pending')).json; },
    async decide(id, verb, body) { return (await api('POST', `/api/pair/pending/${id}/${verb}`, body ?? {})).status; },
    async devices() { return (await api('GET', '/api/pair/devices')).json; },
    async revoke(dev) { return (await api('DELETE', `/api/pair/devices/${dev}`)).status; },
    async clipboard(token, method = 'GET', body) {
      const res = await fetch(`${url}/api/clipboard`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Copa-Namespace': 'default' }, body });
      return res.status;
    },
  };
}
