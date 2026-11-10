import type { EndpointConfig, PairingAuth } from '../config';
import { StateEmitter } from './emitter';
import type { PairingAttempt, PairingCapable, PairingEnv } from './pairing';
import { CopaAuthError, type AuthProvider, type AuthState } from './types';

/**
 * The pairing provider (and the Ed25519 code it needs) is its own chunk, loaded when a
 * `pairing` endpoint is configured — embedders using other methods never download it.
 */
export class LazyPairingProvider implements AuthProvider, PairingCapable {
  readonly method = 'pairing' as const;
  readonly protocol: 'spake2' | 'ecdh';

  private real: import('./pairing').PairingProvider | null = null;
  private readonly emitter = new StateEmitter('signed-out');
  private readonly loading: Promise<import('./pairing').PairingProvider>;

  constructor(endpoint: EndpointConfig, auth: PairingAuth, env?: PairingEnv) {
    this.protocol = auth.protocol;
    this.loading = import('./pairing').then((m) => {
      const p = new m.PairingProvider(endpoint, auth, env);
      this.real = p;
      p.onChange((s) => this.emitter.set(s));
      this.emitter.set(p.state());
      return p;
    });
    this.loading.catch(() => undefined);
  }

  get lastError(): CopaAuthError | null { return this.real?.lastError ?? null; }

  state(): AuthState { return this.real ? this.real.state() : this.emitter.state; }

  onChange(cb: (state: AuthState) => void): () => void { return this.emitter.subscribe(cb); }

  getHeader(): Promise<string> { return this.loading.then((p) => p.getHeader()); }

  refresh(): Promise<boolean> { return this.loading.then((p) => p.refresh(), () => false); }

  renew(): Promise<boolean> { return this.loading.then((p) => p.renew(), () => false); }

  beginPairing(input: string, deviceName?: string): Promise<PairingAttempt> {
    return this.loading.then((p) => p.beginPairing(input, deviceName));
  }

  signOut(): Promise<void> { return this.loading.then((p) => p.signOut(), () => undefined); }

  ready(): Promise<void> { return this.loading.then(() => undefined); }
}
