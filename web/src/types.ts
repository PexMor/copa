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
