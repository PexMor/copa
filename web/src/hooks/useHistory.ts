import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CopaServer, HistoryEvent, HistoryItem } from '../types';
import { fetchHistory } from '../utils/api';

interface UseHistoryOpts {
  server: CopaServer | null;
  namespace: string;
  /** Server supports history and the token can read it. */
  enabled: boolean;
  /** Keep the list current through /ws/events. */
  live: boolean;
}

export function useHistory({ server, namespace, enabled, live }: UseHistoryOpts) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!server || !enabled) { setItems([]); return; }
    try {
      setItems(await fetchHistory(server, namespace));
    } catch { /* keep what we have */ }
  }, [server?.id, server?.url, server?.token, namespace, enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  // Tick so remaining lifetimes count down and expired items drop out.
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [items.length === 0]);

  useEffect(() => {
    if (!server || !enabled || !live) return;
    activeRef.current = true;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (!activeRef.current) return;
      const url = server.url.replace(/^http/, 'ws')
        + `/ws/events?token=${encodeURIComponent(server.token)}&namespace=${encodeURIComponent(namespace)}`;
      ws = new WebSocket(url);
      ws.onopen = () => { refresh(); };
      ws.onmessage = (e) => {
        let ev: HistoryEvent;
        try { ev = JSON.parse(e.data as string) as HistoryEvent; } catch { return; }
        if (ev.type === 'item_added') {
          const item = ev.item;
          // upsert: a refreshed item is announced again with the same id
          setItems((prev) => [item, ...prev.filter((i) => i.id !== item.id)]);
        } else if (ev.type === 'item_removed') {
          const id = ev.id;
          setItems((prev) => prev.filter((i) => i.id !== id));
        }
      };
      ws.onclose = () => {
        if (activeRef.current) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => { ws?.close(); };
    };
    connect();

    return () => {
      activeRef.current = false;
      if (retry) clearTimeout(retry);
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, [server?.id, server?.url, server?.token, namespace, enabled, live, refresh]);

  const visible = items.filter((i) => i.expires_at > now);
  return { items: visible, now, refresh };
}
