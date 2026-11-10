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

export type { Capabilities, FileDownload, HistoryEvent, HistoryItem } from '../../web-core/src/types';

export interface UploadState {
  key: string;
  name: string;
  loaded: number;
  total: number;
  error?: string;
}
