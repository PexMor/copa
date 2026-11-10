import type { EndpointConfig } from '../config';

export type AuthState = 'signed-out' | 'pending' | 'ready' | 'expired';

/** Thrown when a credential is needed but unavailable; never carries token text. */
export class CopaAuthError extends Error {
  constructor(
    public code: 'not-authenticated' | 'no-token' | 'unsupported-method' | 'sign-in-failed' | 'cancelled' | 'popup-blocked',
    message: string,
  ) {
    super(message);
    this.name = 'CopaAuthError';
  }
}

/** One implementation per `auth.method`; the API client only knows this seam. */
export interface AuthProvider {
  readonly method: 'static-token' | 'oauth2' | 'pairing';
  state(): AuthState;
  /** Full `Authorization` header value ("Bearer …"); renews credentials if needed. */
  getHeader(): Promise<string>;
  /** After a 401: try to obtain a fresh credential. Resolves true when one is available. */
  refresh?(): Promise<boolean>;
  /** Interactive sign-in (oauth2 / pairing). */
  signIn?(): Promise<void>;
  signOut(): Promise<void>;
  /** Subscribe to state changes; returns an unsubscribe function. */
  onChange(cb: (state: AuthState) => void): () => void;
}

/** Host-registered functions that supply tokens on demand (`tokenFrom`). */
export type TokenSource = () => string | null | undefined | Promise<string | null | undefined>;
export type TokenSources = Record<string, TokenSource>;

export interface AuthContext {
  /** Token providers registered by the host application. */
  tokenSources?: TokenSources;
  /** Browser access for the OAuth2 provider; replaceable for tests and unusual hosts. */
  oauth2Env?: import('./oauth2').OAuth2Env;
  /** Browser access for the pairing provider; replaceable for tests. */
  pairingEnv?: import('./pairing').PairingEnv;
}

/** Optional abilities of interactive providers, used by the UI. */
export interface InteractiveProvider {
  /** Abort a sign-in that is waiting for the user. */
  cancelSignIn?(): void;
  /** Sign in by navigating this page away and back (no pop-up). */
  signInRedirect?(): Promise<void>;
  /** Why the last sign-in (or a returning redirect) failed, if it did. */
  readonly lastError?: CopaAuthError | null;
}

export type AuthFactory = (endpoint: EndpointConfig, ctx: AuthContext) => AuthProvider;
