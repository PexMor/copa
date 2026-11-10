import {
  SUPPORTED_CONFIG_VERSION,
  type AuthConfig, type ConfigIssue, type EndpointConfig, type IssueCode,
  type ValidationResult, type WidgetConfig,
} from './types';

const METHODS = ['static-token', 'oauth2', 'pairing'] as const;
const PERSIST = ['memory', 'session', 'local'] as const;
const FLOWS = ['popup', 'redirect'] as const;
const PROTOCOLS = ['spake2', 'ecdh'] as const;
const IDP_SECRET_KEYS = ['clientId', 'client_id', 'clientSecret', 'client_secret'];

const TOP_KEYS = ['version', 'defaultEndpoint', 'endpoints', 'ui', '$schema'];
const ENDPOINT_KEYS = ['id', 'url', 'namespace', 'auth'];
const AUTH_KEYS: Record<string, string[]> = {
  'static-token': ['method', 'token', 'tokenFrom'],
  oauth2: ['method', 'tokenService', 'loginUrl', 'pollUrl', 'tokenUrl', 'refreshUrl', 'logoutUrl',
    'audience', 'popup', 'persist', 'flow'],
  pairing: ['method', 'protocol', 'ttlHint', 'persist'],
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `http` is only acceptable for loopback hosts. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** null when fine, otherwise the problem. */
export function checkUrl(value: string): { code: IssueCode; message: string } | null {
  let u: URL;
  try { u = new URL(value); } catch { return { code: 'bad-url', message: `"${value}" is not a valid URL` }; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return null;
  return { code: 'insecure-url', message: `"${value}" must use https (http is only allowed for loopback addresses)` };
}

class Ctx {
  errors: ConfigIssue[] = [];
  warnings: string[] = [];
  err(code: IssueCode, path: string, message: string) { this.errors.push({ code, path, message }); }
  warnUnknown(obj: Record<string, unknown>, known: string[], path: string) {
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) this.warnings.push(`${path ? path + '.' : ''}${k}: unknown key ignored`);
    }
  }
}

function str(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string, required: boolean): string | undefined {
  const v = obj[key];
  if (v === undefined) {
    if (required) ctx.err('required', `${path}.${key}`, `missing required key "${key}"`);
    return undefined;
  }
  if (typeof v !== 'string' || v === '') {
    ctx.err('type', `${path}.${key}`, `"${key}" must be a non-empty string`);
    return undefined;
  }
  return v;
}

function urlField(ctx: Ctx, obj: Record<string, unknown>, key: string, path: string, required: boolean): string | undefined {
  const v = str(ctx, obj, key, path, required);
  if (v === undefined) return undefined;
  const problem = checkUrl(v);
  if (problem) { ctx.err(problem.code, `${path}.${key}`, problem.message); return undefined; }
  return v;
}

function validateAuth(ctx: Ctx, raw: unknown, path: string): AuthConfig | undefined {
  if (!isObj(raw)) { ctx.err('required', path, 'missing or invalid "auth" object'); return undefined; }
  const method = raw.method;
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) {
    ctx.err('unknown-method', `${path}.method`,
      `unknown auth method ${JSON.stringify(method)}; expected one of ${METHODS.join(', ')}`);
    return undefined;
  }
  ctx.warnUnknown(raw, AUTH_KEYS[method].concat(method === 'oauth2' ? IDP_SECRET_KEYS : []), path);
  const before = ctx.errors.length;

  if (method === 'static-token') {
    const token = str(ctx, raw, 'token', path, false);
    const tokenFrom = str(ctx, raw, 'tokenFrom', path, false);
    if ((token === undefined) === (tokenFrom === undefined) && ctx.errors.length === before) {
      ctx.err('one-of', path, 'static-token needs exactly one of "token" or "tokenFrom"');
    }
    return ctx.errors.length === before ? { method, ...(token ? { token } : { tokenFrom }) } as AuthConfig : undefined;
  }

  if (method === 'oauth2') {
    for (const k of IDP_SECRET_KEYS) {
      if (k in raw) {
        ctx.err('idp-secret', `${path}.${k}`,
          `"${k}" does not belong in the widget configuration; identity-provider settings live in the token service`);
      }
    }
    const out: Record<string, unknown> = { method };
    const explicit = ['loginUrl', 'tokenUrl', 'refreshUrl', 'logoutUrl'];
    const service = urlField(ctx, raw, 'tokenService', path, false);
    if (service) out.tokenService = service;
    for (const k of [...explicit, 'pollUrl']) {
      const v = urlField(ctx, raw, k, path, false);
      if (v) out[k] = v;
    }
    if (ctx.errors.length === before && !service) {
      const missing = explicit.filter((k) => !(k in raw));
      if (missing.length === explicit.length) {
        ctx.err('required', `${path}.tokenService`, 'missing required key "tokenService" (or all of loginUrl, tokenUrl, refreshUrl, logoutUrl)');
      } else if (missing.length) {
        ctx.err('required', `${path}.${missing[0]}`, `missing required key "${missing[0]}" (no "tokenService" given)`);
      }
    }
    const aud = str(ctx, raw, 'audience', path, false);
    if (aud) out.audience = aud;
    if (raw.persist !== undefined) {
      if (!(PERSIST as readonly unknown[]).includes(raw.persist)) {
        ctx.err('bad-value', `${path}.persist`, `"persist" must be one of ${PERSIST.join(', ')}`);
      } else out.persist = raw.persist;
    }
    if (raw.flow !== undefined) {
      if (!(FLOWS as readonly unknown[]).includes(raw.flow)) {
        ctx.err('bad-value', `${path}.flow`, `"flow" must be one of ${FLOWS.join(', ')}`);
      } else out.flow = raw.flow;
    }
    if (raw.popup !== undefined) {
      const p = raw.popup;
      if (!isObj(p)) ctx.err('type', `${path}.popup`, '"popup" must be an object');
      else {
        const popup: Record<string, number> = {};
        for (const k of ['width', 'height']) {
          const v = p[k];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 200 || v > 4000) {
            ctx.err('bad-value', `${path}.popup.${k}`, `"${k}" must be a number between 200 and 4000`);
          } else popup[k] = v;
        }
        out.popup = popup;
      }
    }
    return ctx.errors.length === before ? (out as unknown as AuthConfig) : undefined;
  }

  // pairing
  const protocol = raw.protocol;
  if (protocol === undefined) ctx.err('required', `${path}.protocol`, 'missing required key "protocol"');
  else if (!(PROTOCOLS as readonly unknown[]).includes(protocol)) {
    ctx.err('bad-value', `${path}.protocol`, `"protocol" must be one of ${PROTOCOLS.join(', ')}`);
  }
  const out: Record<string, unknown> = { method, protocol };
  if (raw.ttlHint !== undefined) {
    if (typeof raw.ttlHint !== 'number' || !Number.isInteger(raw.ttlHint) || raw.ttlHint <= 0) {
      ctx.err('bad-value', `${path}.ttlHint`, '"ttlHint" must be a positive integer (seconds)');
    } else out.ttlHint = raw.ttlHint;
  }
  if (raw.persist !== undefined) {
    if (!(PERSIST as readonly unknown[]).includes(raw.persist)) {
      ctx.err('bad-value', `${path}.persist`, `"persist" must be one of ${PERSIST.join(', ')}`);
    } else out.persist = raw.persist;
  }
  return ctx.errors.length === before ? (out as unknown as AuthConfig) : undefined;
}

function validateEndpoint(ctx: Ctx, raw: unknown, i: number): EndpointConfig | undefined {
  const path = `endpoints[${i}]`;
  if (!isObj(raw)) { ctx.err('type', path, 'endpoint must be an object'); return undefined; }
  ctx.warnUnknown(raw, ENDPOINT_KEYS, path);
  const before = ctx.errors.length;
  const id = str(ctx, raw, 'id', path, true);
  const url = urlField(ctx, raw, 'url', path, true);
  const namespace = str(ctx, raw, 'namespace', path, false) ?? 'default';
  const auth = validateAuth(ctx, raw.auth, `${path}.auth`);
  if (ctx.errors.length !== before || !id || !url || !auth) return undefined;
  return { id, url: url.replace(/\/+$/, ''), namespace, auth };
}

/**
 * Validate a parsed configuration document. Fatal problems (not an object,
 * missing/newer version, no endpoints) fail the whole document; an endpoint
 * with errors is refused on its own and the others stay usable.
 */
export function validateConfig(input: unknown): ValidationResult {
  const ctx = new Ctx();
  const fail = (): ValidationResult => ({ ok: false, errors: ctx.errors, warnings: ctx.warnings });

  if (!isObj(input)) { ctx.err('not-object', '', 'the configuration must be a JSON object'); return fail(); }

  const version = input.version;
  if (version === undefined) { ctx.err('version-missing', 'version', 'missing required key "version"'); return fail(); }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    ctx.err('type', 'version', '"version" must be a positive integer'); return fail();
  }
  if (version > SUPPORTED_CONFIG_VERSION) {
    ctx.err('version-unsupported', 'version',
      `configuration version ${version} is newer than the supported version ${SUPPORTED_CONFIG_VERSION}; please upgrade the widget`);
    return fail();
  }
  ctx.warnUnknown(input, TOP_KEYS, '');

  if (!Array.isArray(input.endpoints) || input.endpoints.length === 0) {
    ctx.err('required', 'endpoints', '"endpoints" must be a non-empty array'); return fail();
  }

  const endpoints: EndpointConfig[] = [];
  const seen = new Set<string>();
  input.endpoints.forEach((raw, i) => {
    const ep = validateEndpoint(ctx, raw, i);
    if (!ep) return;
    if (seen.has(ep.id)) { ctx.err('duplicate-id', `endpoints[${i}].id`, `duplicate endpoint id "${ep.id}"`); return; }
    seen.add(ep.id);
    endpoints.push(ep);
  });

  let defaultEndpoint: string | undefined;
  if (input.defaultEndpoint !== undefined) {
    if (typeof input.defaultEndpoint !== 'string') ctx.err('type', 'defaultEndpoint', '"defaultEndpoint" must be a string');
    else if (!endpoints.some((e) => e.id === input.defaultEndpoint)) {
      ctx.err('unknown-endpoint', 'defaultEndpoint', `defaultEndpoint "${input.defaultEndpoint}" does not name a usable endpoint`);
    } else defaultEndpoint = input.defaultEndpoint;
  }

  let ui: WidgetConfig['ui'];
  if (isObj(input.ui)) {
    ctx.warnUnknown(input.ui, ['theme'], 'ui');
    const t = input.ui.theme;
    if (t !== undefined && t !== 'light' && t !== 'auto' && t !== 'dark') {
      ctx.err('bad-value', 'ui.theme', '"ui.theme" must be light, auto or dark');
    } else ui = t ? { theme: t } : {};
  } else if (input.ui !== undefined) ctx.err('type', 'ui', '"ui" must be an object');

  // errors outside individual endpoints (defaultEndpoint, ui, …) are document-level and fatal
  if (endpoints.length === 0 || ctx.errors.some((e) => !e.path.startsWith('endpoints['))) return fail();
  return {
    ok: true,
    config: { version, endpoints, ...(defaultEndpoint ? { defaultEndpoint } : {}), ...(ui ? { ui } : {}) },
    errors: ctx.errors,
    warnings: ctx.warnings,
  };
}
