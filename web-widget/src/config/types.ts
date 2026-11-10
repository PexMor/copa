/** Shape of `copa-widget.json` (see schema/copa-widget.schema.json). */

export const SUPPORTED_CONFIG_VERSION = 1;

export type PersistMode = 'memory' | 'session' | 'local';

export interface StaticTokenAuth {
  method: 'static-token';
  /** Inline token — visible to anyone who can load the page. */
  token?: string;
  /** Name of a token provider registered by the host application. */
  tokenFrom?: string;
}

export interface OAuth2Auth {
  method: 'oauth2';
  /** Base URL of the token service (endpoints come from its discovery document). */
  tokenService?: string;
  loginUrl?: string;
  pollUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  logoutUrl?: string;
  /** Audience of the copa server; default is the endpoint URL's origin. */
  audience?: string;
  popup?: { width?: number; height?: number };
  persist?: PersistMode;
  /** `popup` (default) or `redirect` (full-page sign-in for environments that block pop-ups). */
  flow?: 'popup' | 'redirect';
}

export interface PairingAuth {
  method: 'pairing';
  protocol: 'spake2' | 'ecdh';
  ttlHint?: number;
  /** Where the device credential is kept across reloads (default `memory`: pair again after a reload). */
  persist?: PersistMode;
}

export type AuthConfig = StaticTokenAuth | OAuth2Auth | PairingAuth;

export interface EndpointConfig {
  id: string;
  url: string;
  namespace: string;
  auth: AuthConfig;
}

export interface UiConfig {
  theme?: 'light' | 'auto' | 'dark';
}

export interface WidgetConfig {
  version: number;
  defaultEndpoint?: string;
  endpoints: EndpointConfig[];
  ui?: UiConfig;
}

export type IssueCode =
  | 'not-object' | 'version-missing' | 'version-unsupported' | 'type' | 'required'
  | 'unknown-method' | 'insecure-url' | 'bad-url' | 'idp-secret' | 'duplicate-id'
  | 'unknown-endpoint' | 'one-of' | 'bad-value';

/** `path` is a JSON-pointer-like location, e.g. `endpoints[1].auth.tokenService`. */
export interface ConfigIssue {
  code: IssueCode;
  path: string;
  message: string;
}

export interface ValidationResult {
  /** True when at least one endpoint is usable and nothing fatal was found. */
  ok: boolean;
  /** Only valid endpoints; endpoints with errors are refused individually. */
  config?: WidgetConfig;
  errors: ConfigIssue[];
  /** Unknown optional keys etc.; the loader logs these to the console. */
  warnings: string[];
}
