import type { ConfigIssue, WidgetConfig } from './types';
import { validateConfig } from './validate';

/** Where the configuration comes from. */
export type ConfigSource =
  | { configUrl: string }
  /** Already-parsed object, or a JSON string. */
  | { config: unknown }
  /** `<script type="application/json">`; default selector `script#copa-config`. */
  | { inline: string | true };

export type ConfigErrorKind = 'network' | 'http' | 'json' | 'schema' | 'missing';

export class ConfigLoadError extends Error {
  constructor(
    public kind: ConfigErrorKind,
    message: string,
    public status?: number,
    public issues: ConfigIssue[] = [],
  ) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

export interface LoadOptions {
  fetch?: typeof fetch;
  document?: Document;
  /** Receives warnings (unknown keys); defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

export type LoadResult =
  | {
    ok: true;
    config: WidgetConfig;
    /** Problems of endpoints that were refused while others stay usable. */
    issues: ConfigIssue[];
    warnings: string[];
  }
  | { ok: false; error: ConfigLoadError };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigLoadError('json', `Configuration is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function read(source: ConfigSource, opts: LoadOptions): Promise<unknown> {
  if ('configUrl' in source) {
    const doFetch = opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(source.configUrl, { credentials: 'omit', cache: 'no-cache', headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new ConfigLoadError('network', `Could not fetch the configuration from ${source.configUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new ConfigLoadError('http', `Fetching the configuration failed with HTTP ${res.status}`, res.status);
    }
    return parseJson(await res.text());
  }
  if ('inline' in source) {
    const selector = source.inline === true ? 'script#copa-config' : source.inline;
    const el = (opts.document ?? document).querySelector(selector);
    if (!el) throw new ConfigLoadError('missing', `No element matches "${selector}" for the inline configuration`);
    return parseJson(el.textContent ?? '');
  }
  return typeof source.config === 'string' ? parseJson(source.config) : source.config;
}

/**
 * Load and validate the widget configuration. Never throws: failures come back
 * as `{ ok: false, error }` with the cause (network, HTTP status, JSON syntax,
 * schema violation) so the widget can show it and forward it to `onError`.
 */
export async function loadConfig(source: ConfigSource, opts: LoadOptions = {}): Promise<LoadResult> {
  let raw: unknown;
  try {
    raw = await read(source, opts);
  } catch (e) {
    return { ok: false, error: e instanceof ConfigLoadError ? e : new ConfigLoadError('network', String(e)) };
  }
  const result = validateConfig(raw);
  const warn = opts.onWarn ?? ((m: string) => console.warn(`[copa-widget] ${m}`));
  result.warnings.forEach((w) => warn(w));
  if (!result.ok || !result.config) {
    const first = result.errors[0];
    return {
      ok: false,
      error: new ConfigLoadError(
        'schema',
        first ? `Invalid configuration: ${first.path || '(root)'}: ${first.message}` : 'Invalid configuration',
        undefined,
        result.errors,
      ),
    };
  }
  return { ok: true, config: result.config, issues: result.errors, warnings: result.warnings };
}
