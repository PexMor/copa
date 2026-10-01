import type { CopaServer, HistoryItem } from '../types';
import { deleteItem, downloadFile, fetchItemText, formatRemaining, formatSize } from '../utils/api';

interface Props {
  server: CopaServer;
  namespace: string;
  items: HistoryItem[];
  now: number;
  canWrite: boolean;
  onRefresh: () => void;
  onLoadText: (text: string) => void;
  onToast: (text: string, type: 'ok' | 'err' | '') => void;
}

export function HistoryPanel({ server, namespace, items, now, canWrite, onRefresh, onLoadText, onToast }: Props) {
  const gone = () => { onToast('Item no longer available', 'err'); onRefresh(); };

  const load = async (item: HistoryItem) => {
    try {
      onLoadText(await fetchItemText(server, namespace, item.id));
      onToast('Loaded into editor', '');
    } catch { gone(); }
  };

  const copy = async (item: HistoryItem) => {
    try {
      const text = await fetchItemText(server, namespace, item.id);
      await navigator.clipboard.writeText(text);
      onToast('Copied to clipboard', 'ok');
    } catch { onToast('Copy failed', 'err'); onRefresh(); }
  };

  const download = async (item: HistoryItem) => {
    try { await downloadFile(server, namespace, item.id); } catch { gone(); }
  };

  const remove = async (item: HistoryItem) => {
    try {
      await deleteItem(server, namespace, item.id);
      onToast('Deleted', 'ok');
    } catch { onToast('Delete failed', 'err'); }
    onRefresh();
  };

  return (
    <div class="card">
      <div class="history-head">
        <h2>History</h2>
        <button class="btn-sm" onClick={onRefresh}>Refresh</button>
      </div>
      {items.length === 0 ? (
        <p class="muted history-empty">Nothing here yet — pushed text and uploaded files appear in this list until they expire.</p>
      ) : (
        <ul class="history-list">
          {items.map((item) => (
            <li key={item.id} class="history-item">
              <span class={`history-kind history-kind-${item.kind}`}>{item.kind}</span>
              <div class="history-body">
                {item.kind === 'file' ? (
                  <button class="history-label history-link" onClick={() => download(item)} title="Download">
                    {item.name}
                  </button>
                ) : (
                  <button class="history-label history-link" onClick={() => load(item)} title="Load into editor">
                    {item.preview || <em class="muted">(empty)</em>}
                  </button>
                )}
                <span class="history-meta muted">
                  {formatSize(item.size)} · expires in {formatRemaining(item.expires_at - now)}
                </span>
              </div>
              <div class="history-actions">
                {item.kind === 'file'
                  ? <button class="btn-sm" onClick={() => download(item)}>Download</button>
                  : <button class="btn-sm" onClick={() => copy(item)}>Copy</button>}
                {canWrite && (
                  <button class="btn-sm danger" onClick={() => remove(item)} aria-label={`Delete ${item.name ?? 'item'}`}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
