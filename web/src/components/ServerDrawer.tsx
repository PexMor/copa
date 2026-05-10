import { useState } from 'preact/hooks';
import type { AnyServer } from '../types';
import { ServerForm } from './ServerForm';

interface Props {
  open: boolean;
  onClose: () => void;
  servers: AnyServer[];
  activeId: string | undefined;
  onActivate: (s: AnyServer) => void;
  onSave: (s: AnyServer) => void;
  onDelete: (id: string) => void;
}

function serverSubtitle(s: AnyServer): string {
  if (s.type === 'mqtt') {
    try { return new URL(s.brokerUrl).host; } catch { return s.brokerUrl; }
  }
  try { return new URL(s.url).host; } catch { return s.url; }
}

export function ServerDrawer({ open, onClose, servers, activeId, onActivate, onSave, onDelete }: Props) {
  const [editing, setEditing] = useState<AnyServer | null | 'new'>(null);

  if (!open) return null;

  const handleSave = (s: AnyServer) => {
    onSave(s);
    setEditing(null);
  };

  return (
    <div class="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="drawer">
        <div class="drawer-header">
          <h2>Servers</h2>
          <button class="btn-sm" onClick={onClose}>✕</button>
        </div>

        {editing === null && (
          <>
            <ul class="server-list">
              {servers.length === 0 && <li class="muted">No servers. Add one below.</li>}
              {servers.map((s) => (
                <li key={s.id} class={s.id === activeId ? 'active' : ''}>
                  <button class="server-name" onClick={() => { onActivate(s); onClose(); }}>
                    {s.name}
                    <span class="muted"> {serverSubtitle(s)}</span>
                    {s.type === 'mqtt' && <span class="server-badge">MQTT</span>}
                  </button>
                  <div class="server-meta-actions">
                    <button class="btn-sm" onClick={() => setEditing(s)}>Edit</button>
                    <button class="btn-sm danger" onClick={() => { if (confirm(`Delete "${s.name}"?`)) onDelete(s.id); }}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
            <button class="btn" onClick={() => setEditing('new')}>+ Add Server</button>
          </>
        )}

        {editing !== null && (
          <ServerForm
            initial={editing === 'new' ? undefined : editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  );
}
