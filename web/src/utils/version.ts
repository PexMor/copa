/**
 * Build identity + client/server compatibility (mirrors src/version.rs).
 * Bump PROTOCOL together with `copa::version::PROTOCOL` when the wire
 * contract changes in a way an older peer cannot cope with.
 */
import type { CopaServer } from '../types';

export const PROTOCOL = 1;

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  built: string;
  protocol: number;
}

export const WEB_VERSION: VersionInfo = { name: 'copa-web', protocol: PROTOCOL, ...__COPA_BUILD__ };

export type Compat =
  | { kind: 'identical' }
  | { kind: 'compatible' }
  | { kind: 'incompatible'; reason: string };

export function compat(local: VersionInfo, remote: VersionInfo): Compat {
  if (local.protocol !== remote.protocol) {
    const older = local.protocol < remote.protocol ? 'web app' : 'server';
    return {
      kind: 'incompatible',
      reason: `protocol mismatch: web ${local.protocol} (${local.version}) vs server ${remote.protocol} (${remote.version}); ${older} is older`,
    };
  }
  return local.version === remote.version && local.commit === remote.commit
    ? { kind: 'identical' }
    : { kind: 'compatible' };
}

export function formatVersion(v: Pick<VersionInfo, 'version' | 'commit' | 'built'>): string {
  return `${v.version} · ${v.commit} · ${v.built.replace('T', ' ').replace(/:\d\dZ$/, 'Z')}`;
}

/** null = server has no /api/version (older copasrv) or could not be read. */
export async function fetchServerVersion(server: CopaServer): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`${server.url}/api/version`, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const v = await res.json() as Partial<VersionInfo>;
    if (typeof v.version !== 'string' || typeof v.protocol !== 'number') return null;
    return { name: v.name ?? 'copasrv', version: v.version, commit: v.commit ?? '?', built: v.built ?? '', protocol: v.protocol };
  } catch {
    return null;
  }
}

// --- console output (styled) ---

const BADGE = 'background:#7c6af7;color:#fff;border-radius:3px;padding:1px 6px;font-weight:bold';
const OK = 'color:#4ade80;font-weight:bold';
const WARN = 'color:#fbbf24;font-weight:bold';
const BAD = 'background:#f87171;color:#000;border-radius:3px;padding:1px 6px;font-weight:bold';
const DIM = 'color:#9ca3af';

export function logWebVersion(): void {
  const v = WEB_VERSION;
  console.log(`%ccopa web%c ${v.version} %c${v.commit}%c ${v.built} %cprotocol ${v.protocol}`, BADGE, 'font-weight:bold', OK, DIM, DIM);
}

export function logServerVersion(server: CopaServer, remote: VersionInfo | null): void {
  if (!remote) {
    console.warn(`%ccopa server%c ${server.url}: no /api/version (older copasrv) — compatibility unknown`, BADGE, WARN);
    return;
  }
  const c = compat(WEB_VERSION, remote);
  const head = `%ccopa server%c ${remote.version} %c${remote.commit}%c ${remote.built} %cprotocol ${remote.protocol}`;
  const styles = [BADGE, 'font-weight:bold', OK, DIM, DIM];
  if (c.kind === 'incompatible') {
    console.error(`${head} %cINCOMPATIBLE%c ${c.reason}`, ...styles, BAD, WARN);
  } else {
    console.log(`${head} %c${c.kind === 'identical' ? 'identical build' : 'compatible (different build)'}`, ...styles, c.kind === 'identical' ? OK : WARN);
  }
}
