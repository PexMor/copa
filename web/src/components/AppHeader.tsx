import type { Server, Theme } from '../types';
import { ThemeToggle } from './ThemeToggle';
import type { WsStatus } from '../hooks/useWebSocket';

interface Props {
  activeServer: Server | null;
  theme: Theme;
  setTheme: (t: Theme) => void;
  wsStatus: WsStatus | 'off';
  onOpenServers: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  off: '',
  disconnected: '○',
  connecting: '◌',
  connected: '●',
};

export function AppHeader({ activeServer, theme, setTheme, wsStatus, onOpenServers }: Props) {
  return (
    <header class="app-header">
      <div class="header-left">
        <span class="logo">copa</span>
        <button class="server-pill" onClick={onOpenServers}>
          {activeServer ? activeServer.name : 'Add Server'}
          {wsStatus !== 'off' && <span class={`ws-dot ws-${wsStatus}`}>{STATUS_LABEL[wsStatus]}</span>}
        </button>
      </div>
      <ThemeToggle theme={theme} setTheme={setTheme} />
    </header>
  );
}
