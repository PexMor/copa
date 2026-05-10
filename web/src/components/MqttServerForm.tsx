import { useState } from 'preact/hooks';
import type { MqttServer } from '../types';
import { generateKey, keyToBase58 } from '../utils/crypto';
import { publishMqtt } from '../utils/mqttPublish';
import { QRScanner } from './QRScanner';
import { KeyQRModal } from './KeyQRModal';

interface Props {
  initial?: MqttServer;
  onSave: (s: MqttServer) => void;
  onCancel: () => void;
}

function randomId() {
  return Math.random().toString(36).slice(2);
}

export function MqttServerForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [brokerUrl, setBrokerUrl] = useState(initial?.brokerUrl ?? 'wss://broker.emqx.io:8084/mqtt');
  const [topic, setTopic] = useState(initial?.topic ?? 'copa/clipboard/default');
  const [aesKey, setAesKey] = useState(initial?.aesKey ?? '');
  const [maxSize, setMaxSize] = useState(initial?.maxMessageSize ?? 65535);
  const [clientId, setClientId] = useState(initial?.clientId ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const [showKeyQR, setShowKeyQR] = useState(false);
  const [scanningKey, setScanningKey] = useState(false);

  const handleGenerate = () => setAesKey(generateKey());

  const handleGenerateAndShare = async () => {
    const key = generateKey();
    setAesKey(key);
    try {
      await navigator.clipboard.writeText(keyToBase58(key));
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch { /* clipboard denied; key is still set and visible as base58 */ }
  };

  const handleCopyBase58 = async () => {
    if (!aesKey.trim()) return;
    try {
      const b58 = keyToBase58(aesKey.trim());
      await navigator.clipboard.writeText(b58);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // clipboard denied — show the value inline so user can copy manually
    }
  };

  const base58Preview = (() => {
    if (!aesKey.trim()) return '';
    try { return keyToBase58(aesKey.trim()); } catch { return ''; }
  })();

  const test = async () => {
    setTesting(true);
    setTestResult('');
    const server: MqttServer = {
      id: initial?.id ?? randomId(),
      name: name.trim() || 'test',
      type: 'mqtt',
      brokerUrl: brokerUrl.trim(),
      topic: topic.trim(),
      aesKey: aesKey.trim(),
      maxMessageSize: maxSize,
      clientId: clientId.trim() || undefined,
    };
    const result = await publishMqtt(server, 'copa-test');
    setTestResult(result.error ? `✗ ${result.error}` : '✓ Connected & published');
    setTesting(false);
  };

  const save = () => {
    if (!name.trim() || !brokerUrl.trim() || !topic.trim() || !aesKey.trim()) return;
    onSave({
      id: initial?.id ?? randomId(),
      name: name.trim(),
      type: 'mqtt',
      brokerUrl: brokerUrl.trim(),
      topic: topic.trim(),
      aesKey: aesKey.trim(),
      maxMessageSize: maxSize,
      clientId: clientId.trim() || undefined,
    });
  };

  return (
    <div class="server-form">
      <h3>{initial ? 'Edit MQTT Broker' : 'Add MQTT Broker'}</h3>
      <label>
        Name
        <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="My broker" />
      </label>
      <label>
        Broker URL
        <input type="url" value={brokerUrl} onInput={(e) => setBrokerUrl((e.target as HTMLInputElement).value)} placeholder="wss://broker.emqx.io:8084/mqtt" />
      </label>
      <label>
        Topic
        <input type="text" value={topic} onInput={(e) => setTopic((e.target as HTMLInputElement).value)} placeholder="copa/clipboard/default" />
      </label>
      <label>
        AES-256 Key
        <div class="key-row">
          <input
            class="key-input"
            type="password"
            value={aesKey}
            onInput={(e) => setAesKey((e.target as HTMLInputElement).value)}
            placeholder="Base64, hex or Base58 (32-byte key)"
          />
          <button class="btn-sm" type="button" onClick={handleGenerate} title="Generate random key">Generate</button>
          <button class="btn-sm" type="button" onClick={handleGenerateAndShare} title="Generate a new key and copy as Base58">{keyCopied ? 'Copied!' : 'Gen & Share'}</button>
          <button class="btn-sm" type="button" onClick={() => setScanningKey(true)} title="Scan AES key from a QR code">Scan QR</button>
        </div>
        {base58Preview && (
          <div class="key-share-row">
            <code class="key-b58" title="Base58-encoded key — safe to share via text">{base58Preview}</code>
            <button
              class={`btn-sm${keyCopied ? ' active' : ''}`}
              type="button"
              onClick={handleCopyBase58}
              title="Copy Base58 key to clipboard"
            >
              {keyCopied ? 'Copied!' : 'Copy Base58'}
            </button>
            <button
              class="btn-sm"
              type="button"
              onClick={() => setShowKeyQR(true)}
              title="Show key as QR code for peer to scan"
            >
              Show QR
            </button>
          </div>
        )}
        <p class="key-hint muted">Share the Base58 key with peers so they can decrypt messages. Accepts Base64, hex, or Base58 input.</p>
      </label>
      <label>
        Max message size (bytes)
        <input
          type="number"
          value={maxSize}
          min={256}
          max={1048576}
          onInput={(e) => setMaxSize(Number((e.target as HTMLInputElement).value))}
        />
      </label>
      <label>
        Client ID <span class="muted">(optional)</span>
        <input type="text" value={clientId} onInput={(e) => setClientId((e.target as HTMLInputElement).value)} placeholder="auto-generated" />
      </label>
      <div class="form-actions">
        <button class="btn" onClick={save} disabled={!name.trim() || !brokerUrl.trim() || !topic.trim() || !aesKey.trim()}>Save</button>
        <button class="btn-sm" onClick={test} disabled={testing || !brokerUrl.trim() || !aesKey.trim()}>{testing ? 'Testing…' : 'Test'}</button>
        <button class="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      {testResult && <p class={testResult.startsWith('✓') ? 'ok' : 'err'}>{testResult}</p>}
      {showKeyQR && base58Preview && (
        <KeyQRModal keyStr={base58Preview} onClose={() => setShowKeyQR(false)} />
      )}
      {scanningKey && (
        <QRScanner
          onScan={(text) => { setAesKey(text.trim()); setScanningKey(false); }}
          onClose={() => setScanningKey(false)}
        />
      )}
    </div>
  );
}
