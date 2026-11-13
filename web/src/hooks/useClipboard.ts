import { useCallback, useState } from 'preact/hooks';
import type { CopaServer } from '../types';
import { apiFor } from '../utils/api';

type Status = 'idle' | 'ok' | 'error';

// All REST goes through the shared client: it treats an HTML (login page)
// reply or a network error as a failure and re-checks the proxy session.
export function useClipboard(server: CopaServer | null, namespace: string) {
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const pull = useCallback(async (silent = false) => {
    if (!server) return;
    if (!silent) setStatus('idle');
    try {
      const text = await apiFor(server, namespace).getClipboard();
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
      await apiFor(server, namespace).postClipboard(body);
      setLastSync(new Date());
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, [server, namespace, content]);

  return { content, setContent, pull, push, status, lastSync };
}
