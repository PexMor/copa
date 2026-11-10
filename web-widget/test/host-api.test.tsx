import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopaAuthError } from '../src/auth';
import { CopaShare, type CopaHandle } from '../src/ui';
import { ShareError } from '../src/session';
import { mockServer, type MockServer, settle } from './mockServer';

const cfg = (auth: unknown = { method: 'static-token', token: 'tok' }) => ({
  version: 1, endpoints: [{ id: 'main', url: 'https://copa.test', namespace: 'team', auth }],
});

let root: HTMLElement;
let server: MockServer;
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); server = mockServer(); });
afterEach(async () => { render(null, root); await settle(); root.remove(); vi.unstubAllGlobals(); });

async function mountWithHandle(extra: Record<string, unknown> = {}, config: unknown = cfg()) {
  let handle!: CopaHandle;
  const onItem = vi.fn();
  const onError = vi.fn();
  render(<CopaShare config={config} onReady={(h) => { handle = h; }} onItem={onItem} onError={onError} {...extra} />, root);
  await vi.waitFor(() => expect(root.querySelector('[data-action="push"], [data-action="pull"]')).not.toBeNull());
  return { handle, onItem, onError };
}

describe('host API: share routing', () => {
  it('small text goes to the clipboard endpoint, no file upload', async () => {
    const { handle, onItem } = await mountWithHandle();
    const item = await handle.share('200 bytes of plain text');
    expect(server.clipboard).toBe('200 bytes of plain text');
    expect(server.count('POST', '/api/files')).toBe(0);
    expect(item).toMatchObject({ kind: 'text' });
    expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text' }));
  });

  it('share(Blob) uploads a file item with that content type and fires onItem with the stored item', async () => {
    const { handle, onItem } = await mountWithHandle();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const item = await handle.share(new Blob([png], { type: 'image/png' }));
    const grant = JSON.parse(server.requests.find((r) => r.method === 'POST' && r.path === '/api/files')!.body!);
    expect(grant).toMatchObject({ content_type: 'image/png', size: 12 });
    expect(grant.name).toBe('clipboard.png');
    expect(item).toMatchObject({ kind: 'file', content_type: 'image/png' });
    expect(onItem).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, kind: 'file' }));
    await vi.waitFor(() => expect(root.querySelector('.copa-history li[data-kind="file"]')).not.toBeNull());
  });

  it('a Blob without a type gets one from its magic bytes', async () => {
    const { handle } = await mountWithHandle();
    await handle.share(new Blob(['%PDF-1.7 hi']));
    const grant = JSON.parse(server.requests.find((r) => r.method === 'POST' && r.path === '/api/files')!.body!);
    expect(grant).toMatchObject({ content_type: 'application/pdf', name: 'clipboard.pdf' });
  });

  it('a named File keeps its name', async () => {
    const { handle } = await mountWithHandle();
    await handle.share(new File(['abc'], 'notes.md', { type: 'text/markdown' }));
    const grant = JSON.parse(server.requests.find((r) => r.method === 'POST' && r.path === '/api/files')!.body!);
    expect(grant).toMatchObject({ name: 'notes.md', content_type: 'text/markdown' });
  });

  it('text above the limit becomes a file item', async () => {
    const { handle } = await mountWithHandle();
    const item = await handle.share('y'.repeat(150));
    expect(server.count('POST', '/api/clipboard')).toBe(0);
    const grant = JSON.parse(server.requests.find((r) => r.method === 'POST' && r.path === '/api/files')!.body!);
    expect(grant).toMatchObject({ name: 'clipboard.txt', content_type: 'text/plain', size: 150 });
    expect(item.kind).toBe('file');
  });

  it('text above the limit without file support is refused naming the limit', async () => {
    server.caps.files = false;
    const { handle, onError } = await mountWithHandle();
    await expect(handle.share('y'.repeat(150))).rejects.toMatchObject({ code: 'too-large' });
    await expect(handle.share('y'.repeat(150))).rejects.toThrow(/limit is 100 B/);
    expect(server.count('POST', '/api/clipboard')).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it('empty text and blobs are refused', async () => {
    const { handle } = await mountWithHandle();
    await expect(handle.share('')).rejects.toBeInstanceOf(ShareError);
    await expect(handle.share(new Blob([]))).rejects.toThrow(/empty/);
  });

  it('files unsupported: share(Blob) is refused without any request', async () => {
    server.caps.files = false;
    const { handle } = await mountWithHandle();
    await expect(handle.share(new Blob(['x'], { type: 'image/png' }))).rejects.toMatchObject({ code: 'unsupported' });
    expect(server.count('POST', '/api/files')).toBe(0);
  });

  it('a read-only credential cannot share', async () => {
    server.caps.write = false;
    const { handle } = await mountWithHandle();
    await expect(handle.share('x')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('shows upload progress for host-initiated transfers', async () => {
    const { holdUploads } = await import('./mockServer');
    const release = holdUploads();
    const { handle } = await mountWithHandle();
    const p = handle.share(new Blob(['abc'], { type: 'text/plain' }), { name: 'a.txt' });
    await vi.waitFor(() => expect(root.querySelector('.copa-files progress')).not.toBeNull());
    release();
    await p;
  });
});

describe('host API: paste', () => {
  it('returns the current namespace clipboard', async () => {
    server.clipboard = 'current';
    const { handle } = await mountWithHandle();
    expect(await handle.paste()).toBe('current');
  });
});

describe('host API: unauthenticated', () => {
  const noSource = cfg({ method: 'static-token', tokenFrom: 'host' });

  it('rejects with a typed auth error instead of queueing, and shows the sign-in prompt', async () => {
    let handle!: CopaHandle;
    render(<CopaShare config={noSource} onReady={(h) => { handle = h; }} />, root);
    await vi.waitFor(() => expect(root.querySelector('[data-role="auth-state"]')).not.toBeNull());
    const err = await handle.share('hello').catch((e) => e);
    expect(err).toBeInstanceOf(CopaAuthError);
    expect(err.code).toBe('not-authenticated');
    await vi.waitFor(() => expect(root.querySelector('[data-role="sign-in-required"]')).not.toBeNull());
    expect(server.requests).toHaveLength(0);
  });

  it('paste() while signed out is rejected the same way', async () => {
    let handle!: CopaHandle;
    render(<CopaShare config={noSource} onReady={(h) => { handle = h; }} />, root);
    await vi.waitFor(() => expect(root.querySelector('[data-role="auth-state"]')).not.toBeNull());
    await expect(handle.paste()).rejects.toBeInstanceOf(CopaAuthError);
  });

  it('before the configuration is loaded, calls reject with CopaAuthError', async () => {
    let handle!: CopaHandle;
    render(<CopaShare config="{ nope" onReady={(h) => { handle = h; }} />, root);
    await vi.waitFor(() => expect(handle).toBeDefined());
    await expect(handle.share('x')).rejects.toBeInstanceOf(CopaAuthError);
  });

  it('onAuthChange reports the endpoint state', async () => {
    const onAuthChange = vi.fn();
    render(<CopaShare config={cfg()} onAuthChange={onAuthChange} />, root);
    await vi.waitFor(() => expect(onAuthChange).toHaveBeenCalledWith('ready', 'main'));
  });

  it('signIn on a static-token endpoint is unsupported', async () => {
    const { handle } = await mountWithHandle();
    await expect(handle.signIn()).rejects.toMatchObject({ code: 'unsupported-method' });
  });
});
