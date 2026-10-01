import type { Capabilities, CopaServer, FileDownload, HistoryItem } from '../types';

export function apiHeaders(server: CopaServer, namespace: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${server.token}`,
    'X-Copa-Namespace': namespace,
  };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request(server: CopaServer, namespace: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${server.url}${path}`, {
    ...init,
    headers: { ...apiHeaders(server, namespace), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) message = body.error;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  return res;
}

/** null when the server predates history/files (no capability endpoint). */
export async function fetchCapabilities(server: CopaServer, namespace: string): Promise<Capabilities | null> {
  try {
    const res = await request(server, namespace, '/api/capabilities');
    return await res.json() as Capabilities;
  } catch {
    return null;
  }
}

export async function fetchHistory(server: CopaServer, namespace: string): Promise<HistoryItem[]> {
  const res = await request(server, namespace, '/api/history');
  return await res.json() as HistoryItem[];
}

export async function fetchItemText(server: CopaServer, namespace: string, id: string): Promise<string> {
  const res = await request(server, namespace, `/api/history/${encodeURIComponent(id)}`);
  return res.text();
}

export async function deleteItem(server: CopaServer, namespace: string, id: string): Promise<void> {
  await request(server, namespace, `/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface UploadGrant {
  id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: number;
}

export async function requestUpload(server: CopaServer, namespace: string, file: File): Promise<UploadGrant> {
  const res = await request(server, namespace, '/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, content_type: file.type || undefined }),
  });
  return await res.json() as UploadGrant;
}

export async function completeUpload(server: CopaServer, namespace: string, id: string): Promise<HistoryItem> {
  const res = await request(server, namespace, `/api/files/${encodeURIComponent(id)}/complete`, { method: 'POST' });
  return await res.json() as HistoryItem;
}

/**
 * Ask for a fresh presigned URL and hand it straight to the browser.
 * The URL is used once and never stored. The object is served as an
 * attachment, so navigating to it saves the file under its original name.
 */
export async function downloadFile(server: CopaServer, namespace: string, id: string): Promise<void> {
  const res = await request(server, namespace, `/api/files/${encodeURIComponent(id)}`);
  const info = await res.json() as FileDownload;
  const a = document.createElement('a');
  a.href = info.download_url;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatRemaining(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}
