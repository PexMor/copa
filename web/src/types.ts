export interface CopaServer {
  id: string;
  name: string;
  type: 'copa';
  url: string;
  token: string;
}

export interface MqttServer {
  id: string;
  name: string;
  type: 'mqtt';
  brokerUrl: string;
  topic: string;
  aesKey: string;
  maxMessageSize: number;
  clientId?: string;
}

export type AnyServer = CopaServer | MqttServer;

/** @deprecated Use AnyServer */
export type Server = CopaServer;

export type Theme = 'light' | 'auto' | 'dark';

export type GpsFormat = 'geo' | 'google' | 'mapycz' | 'apple' | 'osm';

export interface GpsPosition {
  lat: number;
  lon: number;
  accuracy: number;
}

export interface ToastMessage {
  id: string;
  text: string;
  type: 'ok' | 'err' | '';
}

/** GET /api/capabilities */
export interface Capabilities {
  history: boolean;
  history_limit: number;
  item_ttl_secs: number;
  files: boolean;
  max_file_size?: number;
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

export interface UploadState {
  key: string;
  name: string;
  loaded: number;
  total: number;
  error?: string;
}
