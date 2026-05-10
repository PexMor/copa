import { useEffect, useRef, useState } from 'preact/hooks';
import type { AnyServer, CopaServer, MqttServer } from '../types';
import { useClipboard } from '../hooks/useClipboard';
import { useWebSocket } from '../hooks/useWebSocket';
import { useMqtt } from '../hooks/useMqtt';
import { QRDisplay } from './QRDisplay';
import { QRScanner } from './QRScanner';

const POLL_OPTIONS = [
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
];

interface Props {
  server: AnyServer | null;
  namespace: string;
  onNamespaceChange: (ns: string) => void;
  onToast: (text: string, type: 'ok' | 'err' | '') => void;
  onWsStatus: (s: 'off' | 'disconnected' | 'connecting' | 'connected') => void;
}

export function ClipboardPanel({ server, namespace, onNamespaceChange, onToast, onWsStatus }: Props) {
  const isMqtt = server?.type === 'mqtt';
  const copaServer = isMqtt ? null : (server as CopaServer | null);
  const mqttServer = isMqtt ? (server as MqttServer) : null;

  const { content: copaContent, setContent: setCopaContent, pull, push, status: clipStatus, lastSync: copaLastSync } = useClipboard(copaServer, namespace);
  const [mqttContent, setMqttContent] = useState('');
  const [mqttLastSync, setMqttLastSync] = useState<Date | null>(null);

  const content = isMqtt ? mqttContent : copaContent;
  const setContent = isMqtt ? setMqttContent : setCopaContent;
  const lastSync = isMqtt ? mqttLastSync : copaLastSync;

  const [liveEnabled, setLiveEnabled] = useState(false);
  const [pollInterval, setPollInterval] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [autoSendOnScan, setAutoSendOnScan] = useState(false);

  const handleMqttMessage = (text: string) => {
    setMqttContent(text);
    setMqttLastSync(new Date());
  };

  const { status: wsStatus, disconnect: wsDisconnect } = useWebSocket({
    server: copaServer,
    namespace,
    enabled: liveEnabled && !isMqtt,
    onMessage: (text) => setCopaContent(text),
  });

  const { status: mqttStatus, disconnect: mqttDisconnect, publish: mqttPublish } = useMqtt({
    server: mqttServer,
    enabled: liveEnabled && isMqtt,
    onMessage: handleMqttMessage,
  });

  const liveStatus = isMqtt ? mqttStatus : wsStatus;

  // Auto-enable live mode when switching to MQTT server
  useEffect(() => {
    if (isMqtt) setLiveEnabled(true);
  }, [isMqtt]);

  useEffect(() => {
    onWsStatus(liveEnabled ? liveStatus : 'off');
  }, [liveEnabled, liveStatus, onWsStatus]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (pollInterval && copaServer) {
      pollRef.current = setInterval(() => pull(true), pollInterval);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollInterval, copaServer, namespace]);

  const handlePull = async () => {
    await pull();
    if (clipStatus === 'error') onToast('Pull failed', 'err');
    else onToast('Pulled', 'ok');
  };

  const handlePush = async () => {
    if (isMqtt) {
      if (!mqttServer?.aesKey) { onToast('Set an AES key in server settings first', 'err'); return; }
      const result = await mqttPublish(content);
      if (result.error) onToast(result.error, 'err');
      else { setMqttLastSync(new Date()); onToast('Published', 'ok'); }
    } else {
      await push();
      if (clipStatus === 'error') onToast('Push failed', 'err');
      else onToast('Pushed', 'ok');
    }
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
    if (liveEnabled) {
      isMqtt ? mqttDisconnect() : wsDisconnect();
      setLiveEnabled(false);
    } else {
      setLiveEnabled(true);
    }
  };

  const handleScan = async (text: string) => {
    setContent(text);
    if (autoSendOnScan && server) {
      if (isMqtt) {
        if (!mqttServer?.aesKey) { onToast('Set an AES key in server settings first', 'err'); return; }
        const result = await mqttPublish(text);
        if (result.error) onToast(result.error, 'err');
        else { setMqttLastSync(new Date()); onToast('Scanned & published', 'ok'); }
      } else {
        await push();
        onToast('Scanned & pushed', 'ok');
      }
    } else {
      onToast('Scanned', '');
    }
  };

  const noKey = isMqtt && !mqttServer?.aesKey;

  return (
    <div class="card">
      <div class="panel-top">
        {isMqtt ? (
          <div class="ns-row">
            <span class="topic-chip" title="MQTT topic">
              {mqttServer?.topic ?? '—'}
            </span>
          </div>
        ) : (
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
        )}
        <div class="panel-actions">
          {!isMqtt && <button class="btn" onClick={handlePull} disabled={!server}>Pull</button>}
          <button class="btn" onClick={handlePush} disabled={!server || noKey} title={noKey ? 'Configure an AES key first' : undefined}>
            {isMqtt ? 'Publish' : 'Push'}
          </button>
        </div>
      </div>

      {noKey && (
        <p class="key-warning">No AES key — open Server settings to generate one before publishing.</p>
      )}

      <textarea
        class="clipboard-area"
        value={content}
        onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
        placeholder={server ? (isMqtt ? 'Messages received via MQTT will appear here…' : 'Clipboard content…') : 'Add a server to get started'}
        rows={8}
      />

      <div class="panel-bottom">
        <div class="bottom-actions">
          <button class="btn-sm" onClick={copyLocal}>Copy</button>
          <button class="btn-sm" onClick={pasteLocal}>Paste</button>
          <button class="btn-sm" onClick={() => setContent('')}>Clear</button>
          <button class="btn-sm" onClick={() => setScanning(true)}>Scan QR</button>
          <label class="scan-toggle" title="Send scanned content immediately">
            <input type="checkbox" checked={autoSendOnScan} onChange={(e) => setAutoSendOnScan((e.target as HTMLInputElement).checked)} />
            Auto-send
          </label>
        </div>

        <div class="sync-row">
          <button
            class={`btn-sm${liveEnabled ? ' active' : ''}`}
            onClick={toggleLive}
            disabled={!server}
            title={isMqtt ? 'MQTT subscription' : 'WebSocket live mode'}
          >
            Live
          </button>

          {!isMqtt && (
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
          )}
        </div>

        {lastSync && (
          <p class="last-sync muted">Last sync: {lastSync.toLocaleTimeString()}</p>
        )}
      </div>

      <QRDisplay content={content} />
      {scanning && <QRScanner onScan={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
