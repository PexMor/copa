import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CopaApi, UploadFailure, uploadFile } from '../src/core';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(extra: Partial<ConstructorParameters<typeof CopaApi>[0]> = {}) {
  return new CopaApi({ baseUrl: 'https://c.test', namespace: 'team', getHeader: () => 'Bearer t1', ...extra });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CopaApi', () => {
  it('sends the injected auth header and namespace', async () => {
    const f = vi.fn().mockResolvedValue(json([]));
    vi.stubGlobal('fetch', f);
    await api().history();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://c.test/api/history');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t1', 'X-Copa-Namespace': 'team' });
  });

  it('maps JSON error bodies to ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'nope' }, 403)));
    await expect(api().history()).rejects.toMatchObject({ status: 403, message: 'nope' });
  });

  it('treats HTML as a login page and reports it', async () => {
    const onFailure = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } })));
    await expect(api({ onFailure }).history()).rejects.toBeInstanceOf(ApiError);
    expect(onFailure).toHaveBeenCalledWith('html');
  });

  it('retries once after a renewed 401, never more', async () => {
    let token = 'old';
    const f = vi.fn()
      .mockResolvedValueOnce(json({ error: 'unauthorized' }, 401))
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal('fetch', f);
    const a = api({ getHeader: () => `Bearer ${token}`, onUnauthorized: async () => { token = 'new'; return true; } });
    await a.history();
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][1].headers.Authorization).toBe('Bearer new');

    const g = vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', g);
    await expect(api({ onUnauthorized: async () => true }).history()).rejects.toMatchObject({ status: 401 });
    expect(g).toHaveBeenCalledTimes(2);
  });

  it('does not retry when renewal fails', async () => {
    const f = vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401));
    vi.stubGlobal('fetch', f);
    await expect(api({ onUnauthorized: async () => false }).history()).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reports network errors', async () => {
    const onFailure = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('x')));
    await expect(api({ onFailure }).history()).rejects.toThrow('x');
    expect(onFailure).toHaveBeenCalledWith('network');
  });
});

describe('capabilitiesStrict', () => {
  it('returns null only for a server without the endpoint (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'not found' }, 404)));
    expect(await api().capabilitiesStrict()).toBeNull();
  });
  it('throws authentication and network errors instead of hiding them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401)));
    await expect(api().capabilitiesStrict()).rejects.toMatchObject({ status: 401 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(api().capabilitiesStrict()).rejects.toThrow('offline');
  });
});

describe('uploadFile', () => {
  const file = (n: number) => new File([new Uint8Array(n)], 'a.bin', { type: 'application/octet-stream' });

  it('rejects empty files and files over the limit before any request', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(uploadFile(api(), file(0), {}, () => {})).rejects.toThrow('file is empty');
    await expect(uploadFile(api(), file(2048), { max_file_size: 1024 }, () => {})).rejects.toThrow(/the limit is 1\.0 KiB/);
    expect(f).not.toHaveBeenCalled();
  });

  it('maps 413 and 507 to friendly messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x' }, 413)));
    await expect(uploadFile(api(), file(10), {}, () => {})).rejects.toThrow('too large for this server');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x' }, 507)));
    await expect(uploadFile(api(), file(10), {}, () => {})).rejects.toBeInstanceOf(UploadFailure);
  });
});
