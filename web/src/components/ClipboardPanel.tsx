import { useEffect, useRef, useState } from 'preact/hooks';
import type { Server } from '../types';
import { useClipboard } from '../hooks/useClipboard';
import { useWebSocket } from '../hooks/useWebSocket';
import { QRDisplay } from './QRDisplay';

const POLL_OPTIONS = [
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
];

interface Props {
  server: Server | null;
  namespace: string;
  onNamespaceChange: (ns: string) => void;
  onToast: (text: string, type: 'ok' | 'err' | '') => void;
  onWsStatus: (s: 'off' | 'disconnected' | 'connecting' | 'connected') => void;
}

export function ClipboardPanel({ server, namespace, onNamespaceChange, onToast, onWsStatus }: Props) {
  const { content, setContent, pull, push, status, lastSync } = useClipboard(server, namespace);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [pollInterval, setPollInterval] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { status: wsStatus, disconnect } = useWebSocket({
    server,
    namespace,
    enabled: liveEnabled,
    onMessage: (text) => setContent(text),
  });

  useEffect(() => {
    onWsStatus(liveEnabled ? wsStatus : 'off');
  }, [liveEnabled, wsStatus, onWsStatus]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (pollInterval && server) {
      pollRef.current = setInterval(() => pull(true), pollInterval);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollInterval, server, namespace]);

  const handlePull = async () => {
    await pull();
    if (status === 'error') onToast('Pull failed', 'err');
    else onToast('Pulled', 'ok');
  };

  const handlePush = async () => {
    await push();
    if (status === 'error') onToast('Push failed', 'err');
    else onToast('Pushed', 'ok');
  };

  const copyLocal = async () => {
    try {
      await navigator.clipboard.writeText(content);
      onToast('Copied to clipboard', 'ok');
    } catch {
      onToast('Copy failed — check permissions', 'err');
    }
  };

  const pasteLocal = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setContent(text);
      onToast('Pasted from clipboard', '');
    } catch {
      onToast('Paste failed — check permissions', 'err');
    }
  };

  const toggleLive = () => {
    if (liveEnabled) { disconnect(); setLiveEnabled(false); }
    else { setLiveEnabled(true); }
  };

  return (
    <div class="card">
      <div class="panel-top">
        <div class="ns-row">
          <input
            class="ns-input"
            list="ns-list"
            value={namespace}
            onInput={(e) => onNamespaceChange((e.target as HTMLInputElement).value)}
            placeholder="namespace"
            aria-label="Namespace"
          />
          <datalist id="ns-list">
            <option value="default" />
          </datalist>
        </div>
        <div class="panel-actions">
          <button class="btn" onClick={handlePull} disabled={!server}>Pull</button>
          <button class="btn" onClick={handlePush} disabled={!server}>Push</button>
        </div>
      </div>

      <textarea
        class="clipboard-area"
        value={content}
        onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
        placeholder={server ? 'Clipboard content…' : 'Add a server to get started'}
        rows={8}
      />

      <div class="panel-bottom">
        <div class="bottom-actions">
          <button class="btn-sm" onClick={copyLocal}>Copy</button>
          <button class="btn-sm" onClick={pasteLocal}>Paste</button>
          <button class="btn-sm" onClick={() => setContent('')}>Clear</button>
        </div>

        <div class="sync-row">
          <button
            class={`btn-sm${liveEnabled ? ' active' : ''}`}
            onClick={toggleLive}
            disabled={!server}
            title="WebSocket live mode"
          >
            Live
          </button>

          <select
            value={pollInterval ?? ''}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              setPollInterval(v ? Number(v) : null);
            }}
            disabled={!server}
            aria-label="Auto-pull interval"
          >
            <option value="">No auto-pull</option>
            {POLL_OPTIONS.map(({ label, ms }) => (
              <option key={ms} value={ms}>{label}</option>
            ))}
          </select>
        </div>

        {lastSync && (
          <p class="last-sync muted">Last sync: {lastSync.toLocaleTimeString()}</p>
        )}
      </div>

      <QRDisplay content={content} />
    </div>
  );
}
