import type { StaticTokenAuth } from '../config';
import { StateEmitter } from './emitter';
import { CopaAuthError, type AuthProvider, type AuthState, type TokenSources } from './types';

/**
 * Fixed bearer token: either inline from the configuration, or fetched on every
 * use from a host-registered source (`tokenFrom`). A host-provided token is
 * never cached or persisted by the widget.
 */
export class StaticTokenProvider implements AuthProvider {
  readonly method = 'static-token' as const;
  private readonly emitter: StateEmitter;
  private lastFromHost: string | undefined;

  constructor(private readonly auth: StaticTokenAuth, private readonly sources: TokenSources = {}) {
    this.emitter = new StateEmitter(this.available() ? 'ready' : 'signed-out');
  }

  private available(): boolean {
    return this.auth.token !== undefined || (this.auth.tokenFrom !== undefined && this.auth.tokenFrom in this.sources);
  }

  state(): AuthState {
    // a host source may be registered after construction
    this.emitter.set(this.available() ? 'ready' : 'signed-out');
    return this.emitter.state;
  }

  private async fetchToken(): Promise<string> {
    if (this.auth.token !== undefined) return this.auth.token;
    const name = this.auth.tokenFrom;
    const source = name !== undefined ? this.sources[name] : undefined;
    if (!source) {
      this.emitter.set('signed-out');
      throw new CopaAuthError('not-authenticated', `No token provider named "${name}" is registered by the host application`);
    }
    let token: string | null | undefined;
    try {
      token = await source();
    } catch {
      this.emitter.set('signed-out');
      throw new CopaAuthError('no-token', `The token provider "${name}" failed`);
    }
    if (!token) {
      this.emitter.set('signed-out');
      throw new CopaAuthError('no-token', `The token provider "${name}" returned no token`);
    }
    this.emitter.set('ready');
    this.lastFromHost = token;
    return token;
  }

  async getHeader(): Promise<string> {
    return `Bearer ${await this.fetchToken()}`;
  }

  /** A host token may rotate; report whether the provider now returns a different one. */
  async refresh(): Promise<boolean> {
    if (this.auth.tokenFrom === undefined) return false; // an inline token cannot change
    const before = this.lastFromHost;
    try {
      const now = await this.fetchToken();
      return now !== before;
    } catch {
      return false;
    }
  }

  async signOut(): Promise<void> {
    this.lastFromHost = undefined;
  }

  onChange(cb: (state: AuthState) => void): () => void {
    return this.emitter.subscribe(cb);
  }
}
