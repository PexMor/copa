/** Wire types shared by the standalone web app and the embeddable widget. */

/** GET /api/capabilities */
export interface Capabilities {
  history: boolean;
  history_limit: number;
  item_ttl_secs: number;
  files: boolean;
  max_file_size?: number;
  /** Largest text item of the namespace, in bytes. */
  size_limit?: number;
  read?: boolean;
  write?: boolean;
}

/** One entry of GET /api/history. Timestamps are unix milliseconds. */
export interface HistoryItem {
  id: string;
  kind: 'text' | 'file';
  created_at: number;
  expires_at: number;
  size: number;
  preview?: string;
  name?: string;
  content_type?: string;
}

/** Frames of the /ws/events stream */
export type HistoryEvent =
  | { type: 'item_added'; item: HistoryItem }
  | { type: 'item_removed'; id: string; reason: 'expired' | 'deleted' | 'evicted' };

/** GET /api/files/{id} — the URL is short-lived and must not be stored. */
export interface FileDownload {
  download_url: string;
  name: string;
  size: number;
  content_type: string;
  expires_at: number;
}

/** POST /api/files */
export interface UploadGrant {
  id: string;
  upload_url: string;
  method: string;
  headers: Record<string, string>;
  expires_at: number;
}
