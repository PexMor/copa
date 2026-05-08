import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Server, ToastMessage } from './types';
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

export function App() {
  const { theme, setTheme } = useTheme();
  const [db, setDb] = useState<IDBDatabase | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [activeServer, setActiveServer] = useState<Server | null>(null);
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
      const all = await getAllServers(database);
      setServers(all);

      // Parse URL fragment for shareable link: #token=...&url=...
      const hash = window.location.hash.slice(1);
      if (hash) {
        const params = new URLSearchParams(hash);
        const urlParam = params.get('url');
        const tokenParam = params.get('token');
        if (urlParam && tokenParam) {
          const existing = all.find((s) => s.url === urlParam && s.token === tokenParam);
          if (existing) {
            setActiveServer(existing);
            await setActiveId(database, existing.id);
          } else {
            const newServer: Server = { id: randomId(), name: new URL(urlParam).host, url: urlParam, token: tokenParam };
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
      const active = all.find((s) => s.id === activeId) ?? all[0] ?? null;
      if (active) {
        setActiveServer(active);
        if (!activeId) await setActiveId(database, active.id);
      }
    });
  }, []);

  const handleActivate = async (s: Server) => {
    setActiveServer(s);
    if (db) await setActiveId(db, s.id);
  };

  const handleSave = async (s: Server) => {
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

        <ShareableLink server={activeServer} onToast={addToast} />
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
