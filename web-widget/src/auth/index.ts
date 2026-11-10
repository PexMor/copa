import type { CopaApiOptions } from '../core';
import { CopaApi } from '../core';
import type { EndpointConfig } from '../config';
import { LazyOAuth2Provider } from './lazy';
import { LazyPairingProvider } from './lazyPairing';
import { StaticTokenProvider } from './staticToken';
import { CopaAuthError, type AuthContext, type AuthProvider } from './types';

export * from './types';
export * from './emitter';
export { StaticTokenProvider } from './staticToken';
export { LazyOAuth2Provider } from './lazy';
export { LazyPairingProvider } from './lazyPairing';
export type { PairingAttempt, PairingCapable, PairingEnv } from './pairing';
export type { MessageLike, OAuth2Env, PopupLike } from './oauth2';

/** Pick the provider for an endpoint's `auth.method`. */
export function createAuthProvider(endpoint: EndpointConfig, ctx: AuthContext = {}): AuthProvider {
  const auth = endpoint.auth;
  switch (auth.method) {
    case 'static-token':
      return new StaticTokenProvider(auth, ctx.tokenSources);
    case 'oauth2':
      return new LazyOAuth2Provider(endpoint, auth, ctx.oauth2Env);
    case 'pairing':
      return new LazyPairingProvider(endpoint, auth, ctx.pairingEnv);
    default:
      throw new CopaAuthError('unsupported-method', 'unsupported auth method');
  }
}

/** API client for an endpoint whose credentials come from `provider`. */
export function createApi(
  endpoint: EndpointConfig,
  provider: AuthProvider,
  extra: Pick<CopaApiOptions, 'onFailure'> = {},
): CopaApi {
  return new CopaApi({
    baseUrl: endpoint.url,
    namespace: endpoint.namespace,
    getHeader: () => provider.getHeader(),
    onUnauthorized: provider.refresh ? () => provider.refresh!() : undefined,
    ...extra,
  });
}
