import { useCallback, useState } from 'preact/hooks';
import type { CopaServer } from '../types';
import { recheckAfterFailure } from '../utils/access';

type Status = 'idle' | 'ok' | 'error';

function apiHeaders(server: CopaServer, namespace: string): HeadersInit {
  return {
    'Authorization': `Bearer ${server.token}`,
    'X-Copa-Namespace': namespace,
  };
}

/** The API answers text/plain; HTML means a proxy login page was served instead. */
function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/html');
}

export function useClipboard(server: CopaServer | null, namespace: string) {
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
      if (isHtml(res)) { recheckAfterFailure(server.url); throw new Error('html'); }
      const text = await res.text();
      setContent(text);
      setLastSync(new Date());
      setStatus('ok');
    } catch {
      recheckAfterFailure(server.url);
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
      recheckAfterFailure(server.url);
      setStatus('error');
    }
  }, [server, namespace, content]);

  return { content, setContent, pull, push, status, lastSync };
}
