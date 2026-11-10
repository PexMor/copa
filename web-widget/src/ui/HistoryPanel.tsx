import { useState } from 'preact/hooks';
import { downloadViaAnchor, formatRemaining, formatSize, type HistoryItem } from '../core';
import type { CopaSession } from '../session';
import { ItemPreview } from './ItemPreview';

interface Props {
  session: CopaSession;
  items: HistoryItem[];
  now: number;
  onRefresh: () => void;
  onDeleted: (id: string) => void;
  onError: (error: unknown) => void;
}

export function HistoryPanel({ session, items, now, onRefresh, onDeleted, onError }: Props) {
  const [fullText, setFullText] = useState<Record<string, string>>({});

  const guard = (fn: () => Promise<void>) => () => { fn().catch(onError); };

  return (
    <section class="copa-history" aria-label="History">
      <div class="copa-row">
        <strong>History</strong>
        <span class="copa-spacer" />
        <button type="button" data-action="refresh" onClick={onRefresh}>Refresh</button>
      </div>
      {items.length === 0 && <div class="copa-muted">Nothing here yet</div>}
      <ul>
        {items.map((item) => (
          <li class="copa-item" key={item.id} data-id={item.id} data-kind={item.kind}>
            <div class="copa-row">
              <strong>{item.kind === 'file' ? item.name ?? 'file' : 'text'}</strong>
              <span class="copa-muted">{formatSize(item.size)} · {formatRemaining(item.expires_at - now)} left</span>
              <span class="copa-spacer" />
              {item.kind === 'file' && session.canRead && (
                <button type="button" data-action="download" onClick={guard(async () => {
                  downloadViaAnchor((await session.fileDownload(item.id)).download_url);
                })}>Download</button>
              )}
              {item.kind === 'text' && session.canRead && fullText[item.id] === undefined && (
                <button type="button" data-action="view" onClick={guard(async () => {
                  const text = await session.itemText(item.id);
                  setFullText((m) => ({ ...m, [item.id]: text }));
                })}>View</button>
              )}
              {session.canWrite && (
                <button type="button" data-action="delete" onClick={guard(async () => {
                  await session.remove(item.id);
                  onDeleted(item.id);
                })}>Delete</button>
              )}
            </div>
            {fullText[item.id] !== undefined
              ? <div class="copa-preview" data-full="true">{fullText[item.id]}</div>
              : <ItemPreview session={session} item={item} />}
          </li>
        ))}
      </ul>
    </section>
  );
}
