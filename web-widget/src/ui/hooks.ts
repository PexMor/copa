import { useEffect, useState } from 'preact/hooks';
import { ConfigLoadError, loadConfig, type ConfigSource, type WidgetConfig } from '../config';
import type { AuthProvider, AuthState } from '../auth';

export type ConfigState =
  | { status: 'loading' }
  | { status: 'ready'; config: WidgetConfig }
  | { status: 'error'; error: ConfigLoadError };

export interface ConfigProps {
  /** Parsed object or JSON string. */
  config?: unknown;
  configUrl?: string;
  inline?: string | true;
}

function sourceOf(p: ConfigProps): ConfigSource | null {
  if (p.config !== undefined) return { config: p.config };
  if (p.configUrl) return { configUrl: p.configUrl };
  if (p.inline) return { inline: p.inline };
  return null;
}

export function useLoadedConfig(props: ConfigProps): ConfigState {
  const [state, setState] = useState<ConfigState>({ status: 'loading' });
  const key = JSON.stringify([props.config ?? null, props.configUrl ?? null, props.inline ?? null]);
  useEffect(() => {
    let live = true;
    const source = sourceOf(props);
    if (!source) {
      setState({ status: 'error', error: new ConfigLoadError('missing', 'No configuration was given (use config, configUrl or inline)') });
      return;
    }
    setState({ status: 'loading' });
    void loadConfig(source).then((r) => {
      if (!live) return;
      setState(r.ok ? { status: 'ready', config: r.config } : { status: 'error', error: r.error });
    });
    return () => { live = false; };
  }, [key]);
  return state;
}

/** Re-render when the provider's auth state changes. */
export function useAuthState(provider: AuthProvider): AuthState {
  const [state, setState] = useState<AuthState>(provider.state());
  useEffect(() => {
    setState(provider.state());
    return provider.onChange(setState);
  }, [provider]);
  return state;
}
