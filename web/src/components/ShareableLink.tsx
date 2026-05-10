import type { CopaServer } from '../types';

interface Props {
  server: CopaServer | null;
  onToast: (text: string, type: 'ok' | 'err' | '') => void;
}

export function ShareableLink({ server, onToast }: Props) {
  if (!server) return null;

  const copyLink = async () => {
    const link = `${window.location.origin}${window.location.pathname}#token=${encodeURIComponent(server.token)}&url=${encodeURIComponent(server.url)}`;
    try {
      await navigator.clipboard.writeText(link);
      onToast('Link copied!', 'ok');
    } catch {
      onToast('Copy failed', 'err');
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(server.token);
      onToast('Token copied!', 'ok');
    } catch {
      onToast('Copy failed', 'err');
    }
  };

  return (
    <div class="card">
      <h2>Share</h2>
      <p class="muted">Token: <code>{server.token.slice(0, 8)}…</code></p>
      <div class="share-actions">
        <button class="btn-sm" onClick={copyToken}>Copy Token</button>
        <button class="btn-sm" onClick={copyLink}>Copy Link</button>
      </div>
    </div>
  );
}
