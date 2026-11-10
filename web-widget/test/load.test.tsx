import { render } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type ConfigLoadError } from '../src/config';
import { ConfigErrorView } from '../src/ui/ConfigErrorView';
import { valid } from './config-fixtures';

const good = valid['minimal static token'];
const text = (body: string, status = 200) => new Response(body, { status });

describe('loadConfig sources', () => {
  it('loads from an object', async () => {
    const r = await loadConfig({ config: good });
    expect(r.ok).toBe(true);
  });

  it('loads from a JSON string', async () => {
    const r = await loadConfig({ config: JSON.stringify(good) });
    expect(r.ok).toBe(true);
  });

  it('loads from configUrl without credentials', async () => {
    const f = vi.fn().mockResolvedValue(text(JSON.stringify(good)));
    const r = await loadConfig({ configUrl: 'https://h.example/copa.json' }, { fetch: f });
    expect(r.ok).toBe(true);
    expect(f.mock.calls[0][0]).toBe('https://h.example/copa.json');
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });

  it('loads from an inline script element', async () => {
    document.body.innerHTML = `<script type="application/json" id="copa-config">${JSON.stringify(good)}</script>`;
    expect((await loadConfig({ inline: true })).ok).toBe(true);
    document.body.innerHTML = '';
  });

  it('reports a missing inline element', async () => {
    const r = await loadConfig({ inline: '#nope' });
    expect(r).toMatchObject({ ok: false, error: { kind: 'missing' } });
  });
});

describe('loadConfig failures', () => {
  const fail = async (r: ReturnType<typeof loadConfig>): Promise<ConfigLoadError> => {
    const v = await r;
    if (v.ok) throw new Error('expected failure');
    return v.error;
  };

  it('network failure', async () => {
    const e = await fail(loadConfig({ configUrl: 'https://h/x' }, { fetch: vi.fn().mockRejectedValue(new TypeError('offline')) }));
    expect(e.kind).toBe('network');
    expect(e.message).toMatch(/offline/);
  });

  it('HTTP status', async () => {
    const e = await fail(loadConfig({ configUrl: 'https://h/x' }, { fetch: vi.fn().mockResolvedValue(text('nope', 404)) }));
    expect(e).toMatchObject({ kind: 'http', status: 404 });
  });

  it('JSON syntax error', async () => {
    const e = await fail(loadConfig({ configUrl: 'https://h/x' }, { fetch: vi.fn().mockResolvedValue(text('{ nope')) }));
    expect(e.kind).toBe('json');
    expect(e.message).toMatch(/not valid JSON/);
  });

  it('schema violation carries the issues', async () => {
    const e = await fail(loadConfig({ config: { version: 1, endpoints: [{ id: 'a', url: 'http://x.example.com', auth: { method: 'pairing', protocol: 'spake2' } }] } }));
    expect(e.kind).toBe('schema');
    expect(e.issues[0]).toMatchObject({ code: 'insecure-url' });
  });

  it('logs unknown-key warnings through onWarn', async () => {
    const onWarn = vi.fn();
    await loadConfig({ config: { ...(good as object), extra: 1 } }, { onWarn });
    expect(onWarn).toHaveBeenCalledWith('extra: unknown key ignored');
  });

  it('keeps usable endpoints and reports the refused ones', async () => {
    const r = await loadConfig({ config: { version: 1, endpoints: [
      { id: 'bad', url: 'https://c.example.com', auth: { method: 'kerberos' } },
      { id: 'ok', url: 'https://c.example.com', auth: { method: 'pairing', protocol: 'spake2' } },
    ] } });
    expect(r.ok && r.config.endpoints.map((e) => e.id)).toEqual(['ok']);
    expect(r.ok && r.issues[0].path).toBe('endpoints[0].auth.method');
  });
});

describe('ConfigErrorView', () => {
  it('renders a visible alert with the cause and issue paths', async () => {
    const r = await loadConfig({ config: { version: 1, endpoints: [{ id: 'a', url: 'https://c.example.com', auth: { method: 'oauth2' } }] } });
    if (r.ok) throw new Error('expected failure');
    const root = document.createElement('div');
    render(<ConfigErrorView error={r.error} />, root);
    const alert = root.querySelector('[role="alert"]');
    expect(alert?.getAttribute('data-kind')).toBe('schema');
    expect(alert?.textContent).toContain('Configuration is invalid');
    expect(alert?.textContent).toContain('endpoints[0].auth.tokenService');
  });
});
