import { useState } from 'preact/hooks';
import type { AnyServer, CopaServer } from '../types';
import { MqttServerForm } from './MqttServerForm';

interface Props {
  initial?: AnyServer;
  onSave: (s: AnyServer) => void;
  onCancel: () => void;
}

function randomId() {
  return Math.random().toString(36).slice(2);
}

function CopaForm({ initial, onSave, onCancel }: { initial?: CopaServer; onSave: (s: CopaServer) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  const test = async () => {
    setTesting(true);
    setTestResult('');
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/clipboard`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      setTestResult(res.ok ? '✓ Connected' : `✗ HTTP ${res.status}`);
    } catch {
      setTestResult('✗ Connection failed');
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    if (!name.trim() || !url.trim() || !token.trim()) return;
    onSave({ id: initial?.id ?? randomId(), name: name.trim(), type: 'copa', url: url.trim().replace(/\/$/, ''), token: token.trim() });
  };

  return (
    <div class="server-form">
      <h3>{initial ? 'Edit Server' : 'Add Server'}</h3>
      <label>
        Name
        <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="My copa" />
      </label>
      <label>
        URL
        <input type="url" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="http://localhost:8080" />
      </label>
      <label>
        Token
        <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="••••••••" />
      </label>
      <div class="form-actions">
        <button class="btn" onClick={save}>Save</button>
        <button class="btn-sm" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test'}</button>
        <button class="btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      {testResult && <p class={testResult.startsWith('✓') ? 'ok' : 'err'}>{testResult}</p>}
    </div>
  );
}

export function ServerForm({ initial, onSave, onCancel }: Props) {
  const [serverType, setServerType] = useState<'copa' | 'mqtt'>(initial?.type ?? 'copa');

  if (initial) {
    if (initial.type === 'mqtt') {
      return <MqttServerForm initial={initial} onSave={onSave} onCancel={onCancel} />;
    }
    return <CopaForm initial={initial} onSave={onSave} onCancel={onCancel} />;
  }

  return (
    <>
      <div class="server-type-toggle">
        <button
          class={`btn-sm${serverType === 'copa' ? ' active' : ''}`}
          onClick={() => setServerType('copa')}
        >
          Copa Server
        </button>
        <button
          class={`btn-sm${serverType === 'mqtt' ? ' active' : ''}`}
          onClick={() => setServerType('mqtt')}
        >
          MQTT Broker
        </button>
      </div>
      {serverType === 'copa'
        ? <CopaForm onSave={onSave} onCancel={onCancel} />
        : <MqttServerForm onSave={onSave} onCancel={onCancel} />}
    </>
  );
}
