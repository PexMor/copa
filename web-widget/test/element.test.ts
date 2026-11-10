import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopaAuthError, CopaShareElement, defineCopaShare, mount } from '../src';
import { mockServer, settle, type MockServer } from './mockServer';

const cfg = () => ({
  version: 1, endpoints: [{ id: 'main', url: 'https://copa.test', namespace: 'team', auth: { method: 'static-token', token: 'tok' } }],
});

let server: MockServer;
let host: HTMLElement;
beforeEach(() => {
  defineCopaShare();
  server = mockServer();
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(async () => { host.remove(); await settle(); vi.unstubAllGlobals(); });

const inShadow = <T extends Element = HTMLElement>(el: Element, sel: string) => el.shadowRoot!.querySelector(sel) as T | null;
const ready = (el: Element) => vi.waitFor(() => expect(inShadow(el, '[data-action="push"]')).not.toBeNull());

describe('<copa-share>', () => {
  it('renders into a shadow root, not into the light DOM', async () => {
    const el = document.createElement('copa-share') as CopaShareElement;
    el.config = cfg();
    host.appendChild(el);
    await ready(el);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.querySelector('.copa-share')).toBeNull(); // host DOM untouched
    expect(document.querySelector('.copa-share')).toBeNull(); // not reachable by host selectors
    expect(inShadow(el, 'style')).not.toBeNull(); // styles live inside the shadow root
  });

  it('loads its configuration from the config-url attribute', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) =>
      u === 'https://host.test/c.json' ? new Response(JSON.stringify(cfg())) : real(u, init)));
    const el = document.createElement('copa-share');
    el.setAttribute('config-url', 'https://host.test/c.json');
    host.appendChild(el);
    await ready(el);
  });

  it('reads an inline <script type="application/json"> child', async () => {
    host.innerHTML = `<copa-share><script type="application/json">${JSON.stringify(cfg())}</script></copa-share>`;
    await ready(host.firstElementChild!);
  });

  it('applies the theme attribute', async () => {
    const el = document.createElement('copa-share');
    el.setAttribute('theme', 'dark');
    (el as CopaShareElement).config = cfg();
    host.appendChild(el);
    await ready(el);
    expect(inShadow(el, '.copa-share')!.getAttribute('data-theme')).toBe('dark');
    el.setAttribute('theme', 'light');
    await vi.waitFor(() => expect(inShadow(el, '.copa-share')!.getAttribute('data-theme')).toBe('light'));
  });

  it('emits composed copa:item, copa:auth and copa:error events', async () => {
    const el = document.createElement('copa-share') as CopaShareElement;
    el.config = cfg();
    const seen: Record<string, unknown[]> = { item: [], auth: [], error: [] };
    host.addEventListener('copa:item', (e) => seen.item.push((e as CustomEvent).detail));
    host.addEventListener('copa:auth', (e) => seen.auth.push((e as CustomEvent).detail));
    host.addEventListener('copa:error', (e) => seen.error.push((e as CustomEvent).detail));
    host.appendChild(el);
    await ready(el);
    expect(seen.auth).toContainEqual({ state: 'ready', endpointId: 'main' });

    await el.share('hello');
    expect(seen.item).toHaveLength(1);
    expect(seen.item[0]).toMatchObject({ kind: 'text' });

    await expect(el.share('')).rejects.toThrow();
    await vi.waitFor(() => expect(seen.error.length).toBeGreaterThan(0));
  });

  it('exposes share/paste as methods', async () => {
    server.clipboard = 'pasted';
    const el = document.createElement('copa-share') as CopaShareElement;
    el.config = cfg();
    host.appendChild(el);
    await ready(el);
    expect(await el.paste()).toBe('pasted');
    await el.share('abc');
    expect(server.clipboard).toBe('abc');
  });

  it('calls before the widget has rendered reject with CopaAuthError', async () => {
    const el = document.createElement('copa-share') as CopaShareElement; // not connected
    await expect(el.share('x')).rejects.toBeInstanceOf(CopaAuthError);
  });

  it('removes its content when disconnected', async () => {
    const el = document.createElement('copa-share') as CopaShareElement;
    el.config = cfg();
    host.appendChild(el);
    await ready(el);
    el.remove();
    expect(el.shadowRoot!.querySelector('.copa-share')).toBeNull();
  });
});

describe('Copa.mount', () => {
  it('mounts into the given element and loads the config from configUrl', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) =>
      u === 'https://host.test/c.json' ? new Response(JSON.stringify(cfg())) : real(u, init)));
    const onItem = vi.fn();
    const m = mount(host, { configUrl: 'https://host.test/c.json', onItem });
    expect(host.contains(m.element)).toBe(true);
    const handle = await m.ready;
    await vi.waitFor(() => expect(inShadow(m.element, '[data-action="push"]')).not.toBeNull());
    await handle.share('via mount');
    expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text' }));
    m.unmount();
    expect(host.contains(m.element)).toBe(false);
  });
});
