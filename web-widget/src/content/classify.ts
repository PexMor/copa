import type { HistoryItem } from '../core';

export type ItemKind = 'text' | 'url' | 'json' | 'html' | 'image' | 'file';

export interface Classification {
  kind: ItemKind;
  /** Best-known MIME type (sniffed, declared or derived). */
  mime: string;
  /** Whether the widget can show an inline preview (text shown as text, images via <img>). */
  previewable: boolean;
}

/** Raster formats that are safe to show through <img>. SVG is deliberately a plain file. */
const PREVIEW_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf',
  json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
  zip: 'application/zip',
};

/** Text-like Blobs up to this size are read to tell JSON/HTML/URL from plain text. */
export const TEXT_SNIFF_LIMIT = 64 * 1024;

const OCTET = 'application/octet-stream';

export function mimeFromName(name: string | undefined): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return m ? EXT_MIME[m[1].toLowerCase()] ?? null : null;
}

/** Magic-byte detection for the formats the widget cares about. */
export function sniffMime(b: Uint8Array): string | null {
  const at = (i: number, s: string) => s.split('').every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (at(0, 'GIF87a') || at(0, 'GIF89a'))) return 'image/gif';
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (b.length >= 12 && at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'image/avif';
  if (b.length >= 2 && at(0, 'BM') && b.length >= 14) return 'image/bmp';
  if (b.length >= 5 && at(0, '%PDF-')) return 'application/pdf';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) ) return 'application/zip';
  return null;
}

const HTML_RE = /^\s*(<!doctype\s+html|<html[\s>]|<(head|body|div|span|p|a|ul|ol|table|h[1-6]|script|style|img|br|form|section|article|svg)[\s>/])/i;

/** Classify pasted/received text from its content. */
export function classifyText(text: string): Classification {
  const t = text.trim();
  if (t === '') return { kind: 'text', mime: 'text/plain', previewable: true };

  if (!/\s/.test(t) && /^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) {
        return { kind: 'url', mime: 'text/uri-list', previewable: true };
      }
    } catch { /* not a URL */ }
  }

  if (t[0] === '{' || t[0] === '[') {
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'object' && v !== null) return { kind: 'json', mime: 'application/json', previewable: true };
    } catch { /* plain text that looks like JSON */ }
  }

  if (HTML_RE.test(t) && /<\/[a-z]|\/>|<!doctype/i.test(t)) {
    return { kind: 'html', mime: 'text/html', previewable: true };
  }
  return { kind: 'text', mime: 'text/plain', previewable: true };
}

/** Classify by MIME type (and file name when the type is missing/generic). */
export function classifyMime(declared: string | undefined, name?: string): Classification {
  let mime = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (mime === '' || mime === OCTET) mime = mimeFromName(name) ?? (mime || OCTET);

  if (mime.startsWith('image/')) {
    return { kind: 'image', mime, previewable: PREVIEW_IMAGES.has(mime) };
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { kind: 'html', mime, previewable: false };
  if (mime === 'application/json' || mime.endsWith('+json')) return { kind: 'json', mime, previewable: false };
  if (mime === 'text/uri-list') return { kind: 'url', mime, previewable: false };
  if (mime.startsWith('text/')) return { kind: 'text', mime, previewable: false };
  return { kind: 'file', mime, previewable: false };
}

/** Classify an item of the history list. Text items carry their (possibly truncated) preview. */
export function classifyItem(item: Pick<HistoryItem, 'kind' | 'preview' | 'name' | 'content_type'>): Classification {
  if (item.kind === 'text') return classifyText(item.preview ?? '');
  return classifyMime(item.content_type, item.name);
}

/**
 * Classify a Blob/File the user is about to share: magic bytes win over the
 * declared type (a "png" that is really HTML must not be previewed as an image);
 * small text-like blobs are read to tell JSON/HTML/URL from plain text.
 */
export async function classifyBlob(blob: Blob & { name?: string }): Promise<Classification> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const sniffed = sniffMime(head);
  if (sniffed) return classifyMime(sniffed, blob.name);

  const declared = classifyMime(blob.type, blob.name);
  if (declared.kind === 'image') return { ...declared, previewable: false }; // claims image, bytes say otherwise

  const textual = declared.kind !== 'file' || declared.mime === OCTET;
  if (textual && blob.size <= TEXT_SNIFF_LIMIT) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
      if (!text.includes('\u0000')) {
        const c = classifyText(text);
        // an explicit MIME type from the user's system wins over content heuristics
        return declared.kind === 'file' ? c : { ...c, kind: c.kind === 'text' ? declared.kind : c.kind };
      }
    } catch { /* not UTF-8: binary */ }
  }
  return declared.kind === 'file' ? declared : { ...declared, kind: 'file', previewable: false };
}
