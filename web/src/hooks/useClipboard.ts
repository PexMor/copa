import { useCallback, useState } from 'preact/hooks';
import type { Server } from '../types';

type Status = 'idle' | 'ok' | 'error';

function apiHeaders(server: Server, namespace: string): HeadersInit {
  return {
    'Authorization': `Bearer ${server.token}`,
    'X-Copa-Namespace': namespace,
  };
}

export function useClipboard(server: Server | null, namespace: string) {
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const pull = useCallback(async (silent = false) => {
    if (!server) return;
    if (!silent) setStatus('idle');
    try {
      const res = await fetch(`${server.url}/api/clipboard`, {
        headers: apiHeaders(server, namespace),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const text = await res.text();
      setContent(text);
      setLastSync(new Date());
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [server, namespace]);

  const push = useCallback(async (value?: string) => {
    if (!server) return;
    const body = value !== undefined ? value : content;
    try {
      const res = await fetch(`${server.url}/api/clipboard`, {
        method: 'POST',
        headers: { ...apiHeaders(server, namespace), 'Content-Type': 'text/plain' },
        body,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setLastSync(new Date());
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [server, namespace, content]);

  return { content, setContent, pull, push, status, lastSync };
}
