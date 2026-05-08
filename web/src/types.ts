export interface Server {
  id: string;
  name: string;
  url: string;
  token: string;
}

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
