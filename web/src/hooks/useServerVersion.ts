import { useEffect, useState } from 'preact/hooks';
import type { CopaServer } from '../types';
import { useAccessEpoch } from './useAccessEpoch';
import { recheckAfterFailure } from '../utils/access';
import { compat, fetchServerVersion, logServerVersion, WEB_VERSION, type Compat, type VersionInfo } from '../utils/version';

export interface ServerVersionState {
  /** undefined while checking, null when the server reports no version. */
  remote: VersionInfo | null | undefined;
  compat: Compat | null;
}

/**
 * Query /api/version when a copa server is selected and again whenever the
 * live connection (re)establishes — the server may have been upgraded.
 */
export function useServerVersion(server: CopaServer | null, connection: string): ServerVersionState {
  const [state, setState] = useState<ServerVersionState>({ remote: undefined, compat: null });
  const epoch = useAccessEpoch();

  useEffect(() => {
    if (!server) { setState({ remote: undefined, compat: null }); return; }
    let cancelled = false;
    void fetchServerVersion(server).then((result) => {
      if (cancelled) return;
      if (result.kind === 'unexpected') {
        // not evidence about the server's version; maybe the session expired
        recheckAfterFailure(server.url);
        setState({ remote: null, compat: null });
        return;
      }
      const remote = result.kind === 'ok' ? result.info : null;
      logServerVersion(server, remote);
      setState({ remote, compat: remote ? compat(WEB_VERSION, remote) : null });
    });
    return () => { cancelled = true; };
  }, [server?.id, server?.url, connection === 'connected', epoch]);

  return state;
}

