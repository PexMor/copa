import { useEffect, useRef, useState } from 'preact/hooks';
import type { Server } from '../types';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

interface UseWebSocketOpts {
  server: Server | null;
  namespace: string;
  enabled: boolean;
  onMessage: (content: string) => void;
}

export function useWebSocket({ server, namespace, enabled, onMessage }: UseWebSocketOpts) {
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const disconnect = () => {
    if (retryRef.current) clearTimeout(retryRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
  };

  useEffect(() => {
    if (!enabled || !server) {
      disconnect();
      return;
    }

    let cancelled = false;

    const connect = () => {
      if (cancelled || !enabledRef.current) return;
      setStatus('connecting');
      const wsUrl = server.url.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(server.token)}&namespace=${encodeURIComponent(namespace)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) { ws.close(); return; }
        setStatus('connected');
      };

      ws.onmessage = (e) => {
        if (!cancelled) onMessage(e.data as string);
      };

      ws.onclose = () => {
        if (cancelled || !enabledRef.current) return;
        setStatus('disconnected');
        retryRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, server?.url, server?.token, namespace, enabled]);

  return { status, disconnect };
}
