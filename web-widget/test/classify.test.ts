// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyBlob, classifyItem, classifyMime, classifyText, sniffMime } from '../src/content';

const bytes = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('classifyText', () => {
  const cases: [string, string, string][] = [
    ['plain sentence', 'hello world', 'text'],
    ['empty', '', 'text'],
    ['whitespace only', '  \n ', 'text'],
    ['single https URL', 'https://example.com/a?b=1#c', 'url'],
    ['URL with surrounding whitespace', '  http://example.com  \n', 'url'],
    ['URL plus words', 'see https://example.com now', 'text'],
    ['two URLs', 'https://a.example https://b.example', 'text'],
    ['javascript URL is not a URL item', 'javascript:alert(1)', 'text'],
    ['ftp URL', 'ftp://example.com/file', 'text'],
    ['bare host', 'example.com', 'text'],
    ['JSON object', '{"a": [1, 2, {"b": null}]}', 'json'],
    ['JSON array', '[1, 2, 3]', 'json'],
    ['pretty JSON', '{\n  "a": 1\n}\n', 'json'],
    ['JSON scalar stays text', '42', 'text'],
    ['JSON string stays text', '"quoted"', 'text'],
    ['broken JSON', '{"a": ', 'text'],
    ['brace text', '{not json}', 'text'],
    ['html document', '<!DOCTYPE html><html><body>x</body></html>', 'html'],
    ['html fragment', '<div class="a">hi</div>', 'html'],
    ['script tag', '<script>alert(1)</script>', 'html'],
    ['self-closing img', '<img src="x.png"/>', 'html'],
    ['less-than math', 'a < b and c > d', 'text'],
    ['angle brackets without closing', '<div', 'text'],
  ];
  for (const [name, input, kind] of cases) {
    it(`${name} → ${kind}`, () => expect(classifyText(input).kind).toBe(kind));
  }

  it('text is previewable and has a MIME type', () => {
    expect(classifyText('x')).toEqual({ kind: 'text', mime: 'text/plain', previewable: true });
    expect(classifyText('{"a":1}')).toMatchObject({ mime: 'application/json', previewable: true });
  });
});

describe('classifyMime', () => {
  const cases: [string, string | undefined, string | undefined, string, boolean][] = [
    ['png', 'image/png', undefined, 'image', true],
    ['jpeg with charset noise', 'IMAGE/JPEG; q=1', undefined, 'image', true],
    ['svg is never previewed', 'image/svg+xml', undefined, 'image', false],
    ['pdf', 'application/pdf', 'a.pdf', 'file', false],
    ['json', 'application/json', undefined, 'json', false],
    ['vendor json', 'application/vnd.api+json', undefined, 'json', false],
    ['html', 'text/html', undefined, 'html', false],
    ['plain', 'text/plain', undefined, 'text', false],
    ['uri list', 'text/uri-list', undefined, 'url', false],
    ['octet-stream with png name', 'application/octet-stream', 'shot.PNG', 'image', true],
    ['empty type with pdf name', '', 'doc.pdf', 'file', false],
    ['unknown', 'application/x-weird', 'x.bin', 'file', false],
    ['nothing at all', undefined, undefined, 'file', false],
  ];
  for (const [name, mime, file, kind, previewable] of cases) {
    it(`${name} → ${kind}${previewable ? ' (previewable)' : ''}`, () => {
      expect(classifyMime(mime, file)).toMatchObject({ kind, previewable });
    });
  }
});

describe('sniffMime', () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
  const cases: [string, Uint8Array, string | null][] = [
    ['png', png, 'image/png'],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), 'image/jpeg'],
    ['gif89a', ascii('GIF89a......'), 'image/gif'],
    ['gif87a', ascii('GIF87a......'), 'image/gif'],
    ['webp', ascii('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    ['avif', ascii('\0\0\0\x1cftypavif'), 'image/avif'],
    ['pdf', ascii('%PDF-1.7\n'), 'application/pdf'],
    ['zip', bytes(0x50, 0x4b, 0x03, 0x04), 'application/zip'],
    ['text', ascii('hello world'), null],
    ['too short png', bytes(0x89, 0x50), null],
    ['empty', new Uint8Array(), null],
  ];
  for (const [name, b, mime] of cases) {
    it(`${name} → ${mime}`, () => expect(sniffMime(b)).toBe(mime));
  }
});

describe('classifyItem (history)', () => {
  it('text items are classified from their content', () => {
    expect(classifyItem({ kind: 'text', preview: 'https://example.com' }).kind).toBe('url');
    expect(classifyItem({ kind: 'text', preview: '<script>x</script>' }).kind).toBe('html');
  });
  it('file items from content type and name', () => {
    expect(classifyItem({ kind: 'file', content_type: 'image/webp', name: 'a.webp' })).toMatchObject({ kind: 'image', previewable: true });
    expect(classifyItem({ kind: 'file', content_type: 'application/octet-stream', name: 'r.pdf' }).kind).toBe('file');
  });
});

describe('classifyBlob', () => {
  const blob = (parts: BlobPart[], type = '', name?: string) => Object.assign(new Blob(parts, { type }), name ? { name } : {});

  it('trusts magic bytes over a lying type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(await classifyBlob(blob([png], 'text/plain'))).toMatchObject({ kind: 'image', mime: 'image/png', previewable: true });
  });

  it('an "image" that is really HTML is not previewed', async () => {
    const c = await classifyBlob(blob(['<html><body>x</body></html>'], 'image/png', 'evil.png'));
    expect(c.previewable).toBe(false);
  });

  it('reads small text blobs to find URL / JSON / HTML', async () => {
    expect((await classifyBlob(blob(['https://example.com'], 'text/plain'))).kind).toBe('url');
    expect((await classifyBlob(blob(['{"a":1}'], ''))).kind).toBe('json');
    expect((await classifyBlob(blob(['<div>x</div>'], 'text/plain'))).kind).toBe('html');
    expect((await classifyBlob(blob(['plain'], 'text/plain'))).kind).toBe('text');
  });

  it('binary or non-UTF-8 content is a file', async () => {
    const bin = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02]);
    expect((await classifyBlob(blob([bin], 'application/octet-stream'))).kind).toBe('file');
    expect((await classifyBlob(blob([new Uint8Array([0xc3, 0x28])], 'text/plain'))).kind).toBe('file');
  });

  it('pdf by magic bytes', async () => {
    expect(await classifyBlob(blob(['%PDF-1.4 ...'], '', 'x.bin'))).toMatchObject({ kind: 'file', mime: 'application/pdf' });
  });

  it('keeps the declared type of other files without reading them', async () => {
    const c = await classifyBlob(blob(['PK-not-really'], 'application/x-custom', 'a.custom'));
    expect(c).toMatchObject({ kind: 'file', mime: 'application/x-custom' });
  });
});
