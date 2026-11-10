import { h, render } from 'preact';
import { CopaAuthError, type AuthState, type TokenSources } from './auth';
import type { HistoryItem } from './core';
import type { ShareData, ShareOptions } from './session';
import { CopaShare, type CopaHandle } from './ui';

export const DEFAULT_TAG = 'copa-share';

/**
 * `<copa-share>` — the widget in a Shadow DOM so host styles and widget styles
 * cannot affect each other.
 *
 * Attributes: `config-url`, `endpoint`, `theme` (light|auto|dark).
 * Properties: `config` (object or JSON string), `tokenSources`.
 * Inline configuration: a child `<script type="application/json">`.
 * Events (composed, bubbling): `copa:item`, `copa:auth`, `copa:error`.
 * Methods: `share()`, `paste()`, `signIn()`, `signOut()`, `whenReady()`.
 */
export class CopaShareElement extends HTMLElement {
  static observedAttributes = ['config-url', 'endpoint', 'theme'];

  private shadow: ShadowRoot;
  private handle: CopaHandle | null = null;
  private readyWaiters: ((h: CopaHandle) => void)[] = [];
  private _config: unknown;
  private _tokenSources: TokenSources | undefined;
  private connected = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  get config(): unknown { return this._config; }
  set config(v: unknown) { this._config = v; this.update(); }

  get tokenSources(): TokenSources | undefined { return this._tokenSources; }
  set tokenSources(v: TokenSources | undefined) { this._tokenSources = v; this.update(); }

  connectedCallback(): void {
    this.connected = true;
    this.update();
  }

  disconnectedCallback(): void {
    this.connected = false;
    render(null, this.shadow);
    this.handle = null;
  }

  attributeChangedCallback(): void {
    if (this.connected) this.update();
  }

  private inlineConfig(): string | undefined {
    const s = this.querySelector('script[type="application/json"]');
    return s?.textContent ?? undefined;
  }

  private update(): void {
    if (!this.connected) return;
    const theme = this.getAttribute('theme');
    const configUrl = this.getAttribute('config-url') ?? undefined;
    const config = this._config ?? (configUrl ? undefined : this.inlineConfig());
    render(
      h(CopaShare, {
        config,
        configUrl: config === undefined ? configUrl : undefined,
        endpointId: this.getAttribute('endpoint') ?? undefined,
        tokenSources: this._tokenSources,
        theme: theme === 'light' || theme === 'dark' || theme === 'auto' ? theme : undefined,
        onReady: (handle: CopaHandle) => {
          this.handle = handle;
          for (const w of this.readyWaiters.splice(0)) w(handle);
        },
        onItem: (item: HistoryItem) => this.emit('copa:item', item),
        onAuthChange: (state: AuthState, endpointId: string) => this.emit('copa:auth', { state, endpointId }),
        onError: (error: unknown) => this.emit('copa:error', error),
      }),
      this.shadow,
    );
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Resolves with the host API once the widget has rendered. */
  whenReady(): Promise<CopaHandle> {
    return this.handle ? Promise.resolve(this.handle) : new Promise((resolve) => { this.readyWaiters.push(resolve); });
  }

  private call<T>(fn: (h: CopaHandle) => Promise<T>): Promise<T> {
    // Not rendered yet: reject like any other signed-out call instead of queueing.
    if (!this.handle) return Promise.reject(new CopaAuthError('not-authenticated', 'The widget is not connected'));
    return fn(this.handle);
  }

  share(data: ShareData, opts?: ShareOptions): Promise<HistoryItem> { return this.call((h) => h.share(data, opts)); }
  paste(): Promise<string> { return this.call((h) => h.paste()); }
  signIn(): Promise<void> { return this.call((h) => h.signIn()); }
  signOut(): Promise<void> { return this.call((h) => h.signOut()); }
}

/** Register `<copa-share>` (idempotent). */
export function defineCopaShare(tag: string = DEFAULT_TAG): typeof CopaShareElement {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
    customElements.define(tag, CopaShareElement);
  }
  return CopaShareElement;
}
