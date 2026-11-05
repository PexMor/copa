import type { ServerVersionState } from '../hooks/useServerVersion';
import { WEB_VERSION, formatVersion } from '../utils/version';

export function VersionFooter({ server, showServer }: { server: ServerVersionState; showServer: boolean }) {
  const { remote, compat } = server;
  return (
    <footer class="version-footer">
      <span title={`protocol ${WEB_VERSION.protocol}`}>web {formatVersion(WEB_VERSION)}</span>
      {showServer && remote === null && <span class="version-warn"> · server: version unknown (older copasrv)</span>}
      {showServer && remote && (
        <span class={compat?.kind === 'incompatible' ? 'version-bad' : ''} title={`protocol ${remote.protocol}`}>
          {' · '}server {formatVersion(remote)}
        </span>
      )}
      {compat?.kind === 'incompatible' && (
        <div class="version-bad" role="alert">⚠ Incompatible server: {compat.reason}</div>
      )}
    </footer>
  );
}
