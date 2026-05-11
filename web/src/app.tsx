import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AnyServer, CopaServer, MqttServer, ToastMessage } from './types';
import { openDB, getAllServers, putServer, deleteServer, getActiveId, setActiveId, clearActiveId } from './db';
import { useTheme } from './hooks/useTheme';
import { AppHeader } from './components/AppHeader';
import { ServerDrawer } from './components/ServerDrawer';
import { ClipboardPanel } from './components/ClipboardPanel';
import { GpsShare } from './components/GpsShare';
import { ShareableLink } from './components/ShareableLink';
import { Toast } from './components/Toast';
import type { WsStatus } from './hooks/useWebSocket';

function randomId() {
  return Math.random().toString(36).slice(2);
}

interface ConfigJson {
  defaults?: {
    mqttServers?: MqttServer[];
  };
}

async function loadDefaultServers(): Promise<AnyServer[]> {
  try {
    const res = await fetch('./config.json');
    if (!res.ok) return [];
    const cfg = await res.json() as ConfigJson;
    return cfg.defaults?.mqttServers ?? [];
  } catch {
    return [];
  }
}

export function App() {
  const { theme, setTheme } = useTheme();
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [servers, setServers] = useState<AnyServer[]>([]);
  const [activeServer, setActiveServer] = useState<AnyServer | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [namespace, setNamespace] = useState('default');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus | 'off'>('off');

  const addToast = useCallback((text: string, type: ToastMessage['type']) => {
    const id = randomId();
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3000);
  }, []);

  const dismissToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  useEffect(() => {
    openDB().then(async (database) => {
      setDb(database);
      let all = await getAllServers(database);

      // Seed defaults from config.json when the DB is empty
      if (all.length === 0) {
        const defaults = await loadDefaultServers();
        for (const s of defaults) {
          await putServer(database, s);
        }
        all = defaults;
      }

      setServers(all);

      // Parse URL fragment for Copa shareable link: #token=...&url=...
      const hash = window.location.hash.slice(1);
      if (hash) {
        const params = new URLSearchParams(hash);
        const urlParam = params.get('url');
        const tokenParam = params.get('token');
        if (urlParam && tokenParam) {
          const existing = all.find((s) => s.type === 'copa' && (s as CopaServer).url === urlParam && (s as CopaServer).token === tokenParam);
          if (existing) {
            setActiveServer(existing);
            await setActiveId(database, existing.id);
          } else {
            const newServer: CopaServer = { id: randomId(), name: new URL(urlParam).host, type: 'copa', url: urlParam, token: tokenParam };
            await putServer(database, newServer);
            setServers((prev) => [...prev, newServer]);
            setActiveServer(newServer);
            await setActiveId(database, newServer.id);
          }
          history.replaceState(null, '', window.location.pathname + window.location.search);
          return;
        }
      }

      const activeId = await getActiveId(database);
      if (activeId) {
        const active = all.find((s) => s.id === activeId) ?? null;
        if (active) {
          setActiveServer(active);
        } else {
          await clearActiveId(database);
        }
      }
    });
  }, []);

  const handleActivate = async (s: AnyServer) => {
    setActiveServer(s);
    if (db) await setActiveId(db, s.id);
  };

  const handleSave = async (s: AnyServer) => {
    if (!db) return;
    await putServer(db, s);
    setServers((prev) => {
      const idx = prev.findIndex((x) => x.id === s.id);
      return idx >= 0 ? prev.map((x) => (x.id === s.id ? s : x)) : [...prev, s];
    });
    if (!activeServer) {
      setActiveServer(s);
      await setActiveId(db, s.id);
    }
  };

  const handleDelete = async (id: string) => {
    if (!db) return;
    await deleteServer(db, id);
    setServers((prev) => prev.filter((s) => s.id !== id));
    if (activeServer?.id === id) {
      const remaining = servers.filter((s) => s.id !== id);
      const next = remaining[0] ?? null;
      setActiveServer(next);
      if (next) await setActiveId(db, next.id);
      else await clearActiveId(db);
    }
  };

  const copaServer = activeServer?.type === 'copa' ? (activeServer as CopaServer) : null;

  return (
    <>
      <AppHeader
        activeServer={activeServer}
        theme={theme}
        setTheme={setTheme}
        wsStatus={wsStatus}
        onOpenServers={() => setDrawerOpen(true)}
      />

      <main class="main">
        <ClipboardPanel
          server={activeServer}
          namespace={namespace}
          onNamespaceChange={setNamespace}
          onToast={addToast}
          onWsStatus={setWsStatus}
        />

        <GpsShare server={activeServer} namespace={namespace} onToast={addToast} />

        {copaServer && <ShareableLink server={copaServer} onToast={addToast} />}
      </main>

      <ServerDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        servers={servers}
        activeId={activeServer?.id}
        onActivate={handleActivate}
        onSave={handleSave}
        onDelete={handleDelete}
      />

      <Toast messages={toasts} onDismiss={dismissToast} />
    </>
  );
}
