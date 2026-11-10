import type { EndpointConfig, OAuth2Auth } from '../config';
import { StateEmitter } from './emitter';
import type { OAuth2Env, OAuth2Provider } from './oauth2';
import { CopaAuthError, type AuthProvider, type AuthState, type InteractiveProvider } from './types';

/**
 * The OAuth2 provider lives in its own chunk, loaded when an `oauth2` endpoint is first
 * used — embedders that only use static tokens never download it.
 *
 * The import starts at construction, long before the user can click "Sign in", so by then
 * `signIn()` can open the pop-up synchronously (a pop-up opened after an `await` is
 * blocked by browsers). If the chunk is somehow not there yet, sign-in waits for it.
 */
export class LazyOAuth2Provider implements AuthProvider, InteractiveProvider {
  readonly method = 'oauth2' as const;

  private real: OAuth2Provider | null = null;
  private readonly emitter = new StateEmitter('signed-out');
  private readonly loading: Promise<OAuth2Provider>;
  private loadError: CopaAuthError | null = null;

  constructor(endpoint: EndpointConfig, auth: OAuth2Auth, env?: OAuth2Env) {
    this.loading = import('./oauth2')
      .then((m) => {
        const p = new m.OAuth2Provider(endpoint, auth, env);
        this.real = p;
        p.onChange((s) => this.emitter.set(s));
        this.emitter.set(p.state());
        void p.warmUp();
        return p;
      })
      .catch((e) => {
        this.loadError = new CopaAuthError('sign-in-failed', `Could not load the sign-in code (${e instanceof Error ? e.message : String(e)})`);
        throw this.loadError;
      });
    this.loading.catch(() => undefined); // surfaced by the first call that needs it
  }

  get lastError(): CopaAuthError | null { return this.loadError ?? this.real?.lastError ?? null; }

  state(): AuthState { return this.real ? this.real.state() : this.emitter.state; }

  onChange(cb: (state: AuthState) => void): () => void { return this.emitter.subscribe(cb); }

  getHeader(): Promise<string> { return this.loading.then((p) => p.getHeader()); }

  refresh(): Promise<boolean> { return this.loading.then((p) => p.refresh(), () => false); }

  signIn(): Promise<void> {
    // Synchronous path: keeps the pop-up inside the click's user gesture.
    return this.real ? this.real.signIn() : this.loading.then((p) => p.signIn());
  }

  signInRedirect(): Promise<void> { return this.loading.then((p) => p.signInRedirect()); }

  cancelSignIn(): void { this.real?.cancelSignIn(); }

  signOut(): Promise<void> { return this.loading.then((p) => p.signOut(), () => undefined); }

  /** Resolves when the chunk is loaded (tests, and hosts that want to be sure). */
  ready(): Promise<void> { return this.loading.then(() => undefined); }
}
