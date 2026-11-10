import type { TokenSources } from './auth';
import { CopaShareElement, DEFAULT_TAG, defineCopaShare } from './element';
import type { CopaHandle } from './ui';

export interface MountOptions {
  /** URL of the JSON configuration. */
  configUrl?: string;
  /** Already-loaded configuration (object or JSON string). */
  config?: unknown;
  endpointId?: string;
  theme?: 'light' | 'auto' | 'dark';
  tokenSources?: TokenSources;
  onItem?: (item: unknown) => void;
  onAuthChange?: (state: string, endpointId: string) => void;
  onError?: (error: unknown) => void;
}

export interface Mounted {
  element: CopaShareElement;
  /** Host API; resolves once rendered. */
  ready: Promise<CopaHandle>;
  unmount(): void;
}

/** For pages without a build step: `Copa.mount(el, { configUrl })`. */
export function mount(target: Element, opts: MountOptions): Mounted {
  defineCopaShare();
  const el = document.createElement(DEFAULT_TAG) as CopaShareElement;
  if (opts.configUrl) el.setAttribute('config-url', opts.configUrl);
  if (opts.endpointId) el.setAttribute('endpoint', opts.endpointId);
  if (opts.theme) el.setAttribute('theme', opts.theme);
  if (opts.tokenSources) el.tokenSources = opts.tokenSources;
  if (opts.config !== undefined) el.config = opts.config;
  if (opts.onItem) el.addEventListener('copa:item', (e) => opts.onItem!((e as CustomEvent).detail));
  if (opts.onAuthChange) {
    el.addEventListener('copa:auth', (e) => {
      const d = (e as CustomEvent<{ state: string; endpointId: string }>).detail;
      opts.onAuthChange!(d.state, d.endpointId);
    });
  }
  if (opts.onError) el.addEventListener('copa:error', (e) => opts.onError!((e as CustomEvent).detail));
  target.appendChild(el);
  return { element: el, ready: el.whenReady(), unmount: () => el.remove() };
}
