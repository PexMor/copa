import { useEffect, useState } from 'preact/hooks';
import type { HistoryItem } from '../core';
import { classifyItem } from '../content';
import type { CopaSession } from '../session';

/** Safe http(s) link or null. */
function safeHref(text: string): string | null {
  try {
    const u = new URL(text.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Thumbnail from a fresh presigned URL, requested when shown and never kept. */
function ImageThumb({ session, item }: { session: CopaSession; item: HistoryItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    session.fileDownload(item.id).then((d) => { if (live) setUrl(d.download_url); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [session, item.id]);
  if (failed) return <div class="copa-muted">preview unavailable</div>;
  if (!url) return <div class="copa-muted">loading preview…</div>;
  return <img class="copa-thumb" src={url} alt={item.name ?? 'image'} referrerpolicy="no-referrer" />;
}

/**
 * Preview suited to the item class. Received content is only ever rendered as
 * text nodes (or an <img> from a presigned URL): HTML is shown as source.
 */
export function ItemPreview({ session, item }: { session: CopaSession; item: HistoryItem }) {
  const c = classifyItem(item);
  if (c.kind === 'image' && c.previewable) return <ImageThumb session={session} item={item} />;
  if (item.kind === 'file') return <div class="copa-muted">{item.content_type ?? 'file'}</div>;
  const text = item.preview ?? '';
  if (c.kind === 'url') {
    const href = safeHref(text);
    return href
      ? <div class="copa-preview"><a href={href} target="_blank" rel="noopener noreferrer">{text.trim()}</a></div>
      : <div class="copa-preview">{text}</div>;
  }
  if (c.kind === 'json') return <div class="copa-preview" data-kind="json">{prettyJson(text)}</div>;
  return <div class="copa-preview" data-kind={c.kind}>{text}</div>;
}
