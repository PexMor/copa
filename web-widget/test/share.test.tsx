import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopaShare, type CopaShareProps } from '../src/ui';
import { holdUploads, mockServer, setObjectStoreFailure, type MockServer, settle } from './mockServer';

const config = (extra: Record<string, unknown> = {}, auth: unknown = { method: 'static-token', token: 'tok' }) => ({
  version: 1,
  endpoints: [{ id: 'main', url: 'https://copa.test', namespace: 'team', auth }],
  ...extra,
});

let root: HTMLElement;
let server: MockServer;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  server = mockServer();
});
afterEach(async () => {
  render(null, root);
  await settle();
  root.remove();
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch { /* ignore */ }
});

async function mount(props: Partial<CopaShareProps> = {}) {
  render(<CopaShare config={config()} {...props} />, root);
  await vi.waitFor(() => expect(root.querySelector('[data-action="pull"], [data-action="push"], [role="alert"]')).not.toBeNull());
}
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector(sel) as T | null;
/** Type like a user: wait until the re-render enabled the Push button. */
const type = async (value: string) => {
  const ta = q<HTMLTextAreaElement>('textarea')!;
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-action="push"]')!.disabled).toBe(false));
};
const click = (sel: string) => q(sel)!.click();
const drop = (files: File[]) => {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files } });
  q('.copa-drop')!.dispatchEvent(ev);
};
const paste = (files: File[]) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files } });
  q('.copa-files')!.dispatchEvent(ev);
  return ev;
};
const file = (name: string, size: number, type = 'application/octet-stream') => new File([new Uint8Array(size)], name, { type });

describe('mounting', () => {
  it('connects with the configured endpoint, namespace and token', async () => {
    await mount();
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    const first = server.requests.find((r) => r.path === '/api/capabilities')!;
    expect(first).toMatchObject({ auth: 'Bearer tok', ns: 'team' });
  });

  it('shows an alert for an invalid configuration instead of the widget', async () => {
    render(<CopaShare config={{ version: 2, endpoints: [] }} />, root);
    await vi.waitFor(() => expect(q('[role="alert"]')).not.toBeNull());
    expect(q('[role="alert"]')!.textContent).toContain('upgrade');
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([]); // no request before the config is valid
  });

  it('reports configuration errors through onError', async () => {
    const onError = vi.fn();
    render(<CopaShare config="{ nope" onError={onError} />, root);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatchObject({ kind: 'json' });
  });

  it('loads the configuration from a URL', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) =>
      u === 'https://host.test/copa.json' ? new Response(JSON.stringify(config())) : real(u, init)));
    render(<CopaShare configUrl="https://host.test/copa.json" />, root);
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
  });
});

describe('sharing text', () => {
  it('pushes text and shows success', async () => {
    await mount();
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    await type('hello team');
    click('[data-action="push"]');
    await vi.waitFor(() => expect(q('[role="status"]')!.textContent).toBe('Pushed'));
    expect(server.clipboard).toBe('hello team');
    expect(server.requests.find((r) => r.method === 'POST' && r.path === '/api/clipboard')!.body).toBe('hello team');
  });

  it('pulls the current value into the text box', async () => {
    server.clipboard = 'from elsewhere';
    await mount();
    await vi.waitFor(() => expect(q('[data-action="pull"]')).not.toBeNull());
    click('[data-action="pull"]');
    await vi.waitFor(() => expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('from elsewhere'));
  });

  it('read-only credential: no push control, pull still works', async () => {
    server.caps.write = false;
    server.clipboard = 'readable';
    await mount();
    await vi.waitFor(() => expect(q('[data-action="pull"]')).not.toBeNull());
    expect(q('[data-action="push"]')).toBeNull();
    expect(q('.copa-files')).toBeNull();
    click('[data-action="pull"]');
    await vi.waitFor(() => expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('readable'));
  });

  it('text over the namespace limit, with files unavailable, shows the limit and sends nothing', async () => {
    server.caps.files = false;
    await mount();
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    await type('x'.repeat(150));
    click('[data-action="push"]');
    await vi.waitFor(() => expect(q('[role="status"]')!.textContent).toMatch(/limit is 100 B/));
    expect(server.count('POST', '/api/clipboard')).toBe(0);
  });
});

describe('content-type aware items', () => {
  it('image items show a thumbnail from a fresh presigned URL', async () => {
    const item = server.addItem({ kind: 'file', name: 'shot.png', content_type: 'image/png', size: 2048 });
    await mount();
    await vi.waitFor(() => expect(q('img.copa-thumb')).not.toBeNull());
    expect(q<HTMLImageElement>('img.copa-thumb')!.getAttribute('src')).toBe(`https://s3.test/get/${item.id}?sig=abc`);
    expect(server.count('GET', `/api/files/${item.id}`)).toBe(1);
  });

  it('HTML text is displayed as text and no script runs', async () => {
    server.addItem({ kind: 'text', preview: '<script>window.__pwned = 1</script><b>x</b>' });
    await mount();
    await vi.waitFor(() => expect(q('.copa-preview')).not.toBeNull());
    expect(q('.copa-preview')!.textContent).toBe('<script>window.__pwned = 1</script><b>x</b>');
    expect(root.querySelector('.copa-history script, .copa-history b')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('a single URL becomes a link that opens safely', async () => {
    server.addItem({ kind: 'text', preview: 'https://example.com/page?x=1' });
    await mount();
    await vi.waitFor(() => expect(q('.copa-preview a')).not.toBeNull());
    const a = q<HTMLAnchorElement>('.copa-preview a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/page?x=1');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('a javascript: "URL" is never linked', async () => {
    server.addItem({ kind: 'text', preview: 'javascript:alert(1)' });
    await mount();
    await vi.waitFor(() => expect(q('.copa-preview')).not.toBeNull());
    expect(q('.copa-preview a')).toBeNull();
  });

  it('JSON is formatted', async () => {
    server.addItem({ kind: 'text', preview: '{"a":1}' });
    await mount();
    await vi.waitFor(() => expect(q('.copa-preview[data-kind="json"]')).not.toBeNull());
    expect(q('.copa-preview[data-kind="json"]')!.textContent).toBe('{\n  "a": 1\n}');
  });
});

describe('files', () => {
  it('drop uploads with progress and the item appears in history', async () => {
    await mount();
    await vi.waitFor(() => expect(q('.copa-drop')).not.toBeNull());
    drop([file('report.pdf', 4096, 'application/pdf')]);
    await vi.waitFor(() => expect(q('.copa-history li[data-kind="file"]')).not.toBeNull());
    expect(q('.copa-history li[data-kind="file"]')!.textContent).toContain('report.pdf');
    expect([...server.stored.values()]).toEqual([4096]); // bytes went straight to the object store
    expect(q('.copa-files progress')).toBeNull(); // finished uploads are dismissed
    const grant = server.requests.find((r) => r.method === 'POST' && r.path === '/api/files')!;
    expect(JSON.parse(grant.body!)).toMatchObject({ name: 'report.pdf', size: 4096, content_type: 'application/pdf' });
  });

  it('shows progress while uploading', async () => {
    const release = holdUploads();
    await mount();
    await vi.waitFor(() => expect(q('.copa-drop')).not.toBeNull());
    drop([file('a.bin', 100)]);
    await vi.waitFor(() => expect(q('.copa-files progress')).not.toBeNull());
    expect(q('.copa-files')!.textContent).toContain('a.bin');
    release();
    await vi.waitFor(() => expect(q('.copa-history li[data-kind="file"]')).not.toBeNull());
  });

  it('pasting an image uploads it and inserts no text', async () => {
    await mount();
    await vi.waitFor(() => expect(q('.copa-drop')).not.toBeNull());
    const ev = paste([file('image.png', 300, 'image/png')]);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(q('.copa-history li[data-kind="file"]')).not.toBeNull());
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('');
  });

  it('a file over max_file_size shows the limit and requests no upload', async () => {
    await mount();
    await vi.waitFor(() => expect(q('.copa-drop')).not.toBeNull());
    drop([file('big.bin', 2 * 1024 * 1024)]);
    await vi.waitFor(() => expect(q('.copa-files [role="alert"]')).not.toBeNull());
    expect(q('.copa-files [role="alert"]')!.textContent).toMatch(/the limit is 1\.0 MiB/);
    expect(server.count('POST', '/api/files')).toBe(0);
  });

  it('an upload rejected by the object store reports an error and adds no item', async () => {
    setObjectStoreFailure(403);
    await mount();
    await vi.waitFor(() => expect(q('.copa-drop')).not.toBeNull());
    drop([file('x.bin', 10)]);
    await vi.waitFor(() => expect(q('.copa-files [role="alert"]')).not.toBeNull());
    expect(q('.copa-files [role="alert"]')!.textContent).toMatch(/rejected the upload \(403\)/);
    expect(q('.copa-history li[data-kind="file"]')).toBeNull();
  });

  it('files unsupported: no file controls, text sharing unaffected', async () => {
    server.caps.files = false;
    await mount();
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
    expect(q('.copa-files')).toBeNull();
    await type('plain');
    click('[data-action="push"]');
    await vi.waitFor(() => expect(server.clipboard).toBe('plain'));
  });

  it('file items offer a download that requests a fresh URL', async () => {
    const item = server.addItem({ kind: 'file', name: 'a.zip', content_type: 'application/zip' });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await mount();
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"] [data-action="download"]`)).not.toBeNull());
    click(`li[data-id="${item.id}"] [data-action="download"]`);
    await vi.waitFor(() => expect(clicked).toHaveBeenCalled());
    expect(server.count('GET', `/api/files/${item.id}`)).toBe(1);
    clicked.mockRestore();
  });
});

describe('history', () => {
  it('lists items newest first with size and remaining time', async () => {
    server.addItem({ kind: 'text', preview: 'older' });
    server.addItem({ kind: 'text', preview: 'newer' });
    await mount();
    await vi.waitFor(() => expect(root.querySelectorAll('.copa-history li').length).toBe(2));
    const lis = [...root.querySelectorAll('.copa-history li')].map((l) => l.textContent!);
    expect(lis[0]).toContain('newer');
    expect(lis[0]).toMatch(/1 B · 59m left|1 B · 1h 0m left|1 B · 60m left/);
  });

  it('a writer deletes an item; it disappears from the list and the server', async () => {
    const item = server.addItem({ kind: 'text', preview: 'bye' });
    await mount();
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"]`)).not.toBeNull());
    click(`li[data-id="${item.id}"] [data-action="delete"]`);
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"]`)).toBeNull());
    expect(server.items.find((i) => i.id === item.id)).toBeUndefined();
  });

  it('a reader sees no delete button', async () => {
    server.caps.write = false;
    server.addItem({ kind: 'text', preview: 'x' });
    await mount();
    await vi.waitFor(() => expect(q('.copa-history li')).not.toBeNull());
    expect(q('[data-action="delete"]')).toBeNull();
  });

  it('View loads the full text of a text item', async () => {
    const item = server.addItem({ kind: 'text', preview: 'full text here' });
    await mount();
    await vi.waitFor(() => expect(q(`li[data-id="${item.id}"] [data-action="view"]`)).not.toBeNull());
    click(`li[data-id="${item.id}"] [data-action="view"]`);
    await vi.waitFor(() => expect(q('[data-full="true"]')!.textContent).toBe('full text here'));
  });

  it('manual refresh picks up items added elsewhere', async () => {
    await mount();
    await vi.waitFor(() => expect(q('[data-action="refresh"]')).not.toBeNull());
    server.addItem({ kind: 'text', preview: 'from another device' });
    click('[data-action="refresh"]');
    await vi.waitFor(() => expect(q('.copa-history li')!.textContent).toContain('from another device'));
  });
});

describe('endpoints and auth', () => {
  const two = () => config({}, undefined);

  it('switching endpoints is remembered per browser', async () => {
    const cfg = {
      version: 1,
      endpoints: [
        { id: 'one', url: 'https://copa.test', auth: { method: 'static-token', token: 'tok' } },
        { id: 'two', url: 'https://copa.test', namespace: 'other', auth: { method: 'static-token', token: 'tok' } },
      ],
    };
    render(<CopaShare config={cfg} />, root);
    await vi.waitFor(() => expect(q('select')).not.toBeNull());
    const sel = q<HTMLSelectElement>('select')!;
    sel.value = 'two';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(server.requests.some((r) => r.ns === 'other')).toBe(true));
    render(null, root);
    render(<CopaShare config={cfg} />, root);
    await vi.waitFor(() => expect(q<HTMLSelectElement>('select')!.value).toBe('two'));
    void two;
  });

  it('a wrong token surfaces an error and reports it', async () => {
    server.token = 'other';
    const onError = vi.fn();
    render(<CopaShare config={config()} onError={onError} />, root);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  it('shows the signed-out state when a host token source is missing', async () => {
    render(<CopaShare config={config({}, { method: 'static-token', tokenFrom: 'host' })} />, root);
    await vi.waitFor(() => expect(q('[data-role="auth-state"]')!.textContent).toContain('signed-out'));
    expect(q('[role="alert"]')).not.toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it('works with a host-provided token source', async () => {
    render(<CopaShare config={config({}, { method: 'static-token', tokenFrom: 'host' })} tokenSources={{ host: () => 'tok' }} />, root);
    await vi.waitFor(() => expect(q('[data-action="push"]')).not.toBeNull());
  });
});

describe('access errors are explained', () => {
  it('a rejected static token says so', async () => {
    server.token = 'other';
    render(<CopaShare config={config()} />, root);
    await vi.waitFor(() => expect(q('[data-role="access-error"]')).not.toBeNull());
    expect(q('[data-role="access-error"]')!.textContent).toBe('The server did not accept the token.');
  });

  it('a 403 says the account has no access to the namespace', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) =>
      String(u).endsWith('/api/capabilities')
        ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
        : real(u, init)));
    render(<CopaShare config={config()} />, root);
    await vi.waitFor(() => expect(q('[data-role="access-error"]')).not.toBeNull());
    expect(q('[data-role="access-error"]')!.textContent).toMatch(/no access to this namespace/);
  });
});
