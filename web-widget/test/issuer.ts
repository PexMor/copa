/** Starts the independent Python token issuer (../token-issuer) for tests. Needs `uv`. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// (import.meta.dirname rather than new URL(): jsdom replaces the global URL class)
const ISSUER_DIR = resolve(import.meta.dirname, '../../token-issuer');

export const hasIssuer = (() => {
  try { return spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
})();

export const ADMIN = 'adm-test';

export interface Issuer {
  url: string;
  origin: string;
  /** POST to an /admin/* endpoint. */
  admin(path: string, body?: unknown): Promise<Response>;
  setFaults(...faults: string[]): Promise<void>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export async function startIssuer(extraArgs: string[] = []): Promise<Issuer> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    'uv',
    ['run', 'token-issuer', '--ephemeral', '--port', String(port), '--admin-token', ADMIN, '--log-level', 'warning', ...extraArgs],
    { cwd: ISSUER_DIR, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (let i = 0; i < 200; i++) {
    if (exited) throw new Error('token issuer exited early');
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 199) throw new Error('token issuer did not start');
  }
  const admin = (path: string, body: unknown = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify(body),
    });
  return {
    url,
    origin: url,
    admin,
    async setFaults(...faults) { await admin('/admin/faults', { faults }); },
    async stop() {
      child.kill('SIGTERM');
      await new Promise<void>((r) => { if (exited) r(); else child.on('exit', () => r()); });
    },
  };
}
