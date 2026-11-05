import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build identity, same fields as the server's /api/version.
const cargo = readFileSync(new URL('../Cargo.toml', import.meta.url), 'utf8');
const git = (cmd: string) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
};
const commit = git('git rev-parse --short=7 HEAD') || 'unknown';
const dirty = git('git status --porcelain') ? '-dirty' : '';
const epoch = Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.now() / 1000);
const buildInfo = {
  version: /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? '0.0.0',
  commit: commit + (commit === 'unknown' ? '' : dirty),
  built: new Date(epoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
};

export default defineConfig({
  plugins: [preact()],
  define: { __COPA_BUILD__: JSON.stringify(buildInfo) },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
    allowedHosts: process.env.ALLOWED_HOSTS?.split(',') ?? [],
  },
});
