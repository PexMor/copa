import { useState } from 'preact/hooks';
import type { AnyServer, CopaServer, GpsFormat, GpsPosition, MqttServer } from '../types';
import { publishMqtt } from '../utils/mqttPublish';

const FORMAT_OPTIONS: { value: GpsFormat; label: string; url: (p: GpsPosition) => string }[] = [
  { value: 'geo',    label: 'geo: URI',       url: (p) => `geo:${p.lat},${p.lon}` },
  { value: 'google', label: 'Google Maps',    url: (p) => `https://maps.google.com/?q=${p.lat},${p.lon}` },
  { value: 'mapycz', label: 'Mapy.cz',        url: (p) => `https://mapy.cz/zakladni?x=${p.lon}&y=${p.lat}` },
  { value: 'apple',  label: 'Apple Maps',     url: (p) => `https://maps.apple.com/?q=${p.lat},${p.lon}` },
  { value: 'osm',    label: 'OpenStreetMap',  url: (p) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}` },
];

interface Props {
  server: AnyServer | null;
  namespace: string;
  onToast: (text: string, type: 'ok' | 'err' | '') => void;
}

type State = 'idle' | 'gps' | 'network' | 'ready' | 'error';

export function GpsShare({ server, namespace, onToast }: Props) {
  const [state, setState] = useState<State>('idle');
  const [pos, setPos] = useState<GpsPosition | null>(null);
  const [format, setFormat] = useState<GpsFormat>('google');
  const [errMsg, setErrMsg] = useState('');

  const formatDef = FORMAT_OPTIONS.find((f) => f.value === format)!;
  const formatted = pos ? formatDef.url(pos) : '';

  const requestLocation = () => {
    setState('gps');
    const onSuccess = (gp: GeolocationPosition) => {
      setPos({ lat: gp.coords.latitude, lon: gp.coords.longitude, accuracy: gp.coords.accuracy });
      setState('ready');
    };
    const onGpsError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setErrMsg('Permission denied — allow location in browser site settings');
        setState('error');
        return;
      }
      // GPS unavailable (e.g. desktop) — fall back to network/WiFi location
      setState('network');
      navigator.geolocation.getCurrentPosition(
        onSuccess,
        () => {
          setErrMsg('Location unavailable — check network or device settings');
          setState('error');
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
      );
    };
    navigator.geolocation.getCurrentPosition(onSuccess, onGpsError, { enableHighAccuracy: true, timeout: 10000 });
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      onToast('Copied!', 'ok');
    } catch {
      onToast('Copy failed', 'err');
    }
  };

  const pushToServer = async () => {
    if (!server) { onToast('No server selected', 'err'); return; }
    if (server.type === 'mqtt') {
      const mqtt = server as MqttServer;
      if (!mqtt.aesKey) { onToast('Set an AES key in server settings first', 'err'); return; }
      const result = await publishMqtt(mqtt, formatted);
      if (result.error) onToast(result.error, 'err');
      else onToast('Published!', 'ok');
    } else {
      const copa = server as CopaServer;
      try {
        const res = await fetch(`${copa.url}/api/clipboard`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${copa.token}`,
            'X-Copa-Namespace': namespace,
            'Content-Type': 'text/plain',
          },
          body: formatted,
        });
        if (!res.ok) throw new Error(`${res.status}`);
        onToast('Pushed!', 'ok');
      } catch {
        onToast('Push failed', 'err');
      }
    }
  };

  const pushLabel = server?.type === 'mqtt' ? 'Publish via MQTT' : 'Push to copa';

  return (
    <div class="card">
      <h2>Location</h2>

      {state === 'idle' && (
        <button class="btn" onClick={requestLocation}>Share Location</button>
      )}

      {state === 'gps' && (
        <p class="muted">Requesting GPS location…</p>
      )}

      {state === 'network' && (
        <p class="muted">GPS unavailable — trying network location…</p>
      )}

      {state === 'error' && (
        <div>
          <p class="err">{errMsg || 'Location unavailable'}</p>
          <button class="btn-sm" onClick={() => setState('idle')}>Retry</button>
        </div>
      )}

      {state === 'ready' && pos && (
        <div class="gps-ready">
          <p class="coords">
            {pos.lat.toFixed(6)}, {pos.lon.toFixed(6)}
            <span class="muted"> ±{Math.round(pos.accuracy)}m</span>
          </p>

          <div class="format-picker" role="group" aria-label="Format">
            {FORMAT_OPTIONS.map(({ value, label }) => (
              <label key={value} class={`format-opt${format === value ? ' active' : ''}`}>
                <input type="radio" name="gps-format" value={value} checked={format === value} onChange={() => setFormat(value)} />
                {label}
              </label>
            ))}
          </div>

          <code class="formatted-url">{formatted}</code>

          <div class="gps-actions">
            <button class="btn" onClick={copyToClipboard}>Copy</button>
            {server && <button class="btn" onClick={pushToServer}>{pushLabel}</button>}
            <button class="btn-sm" onClick={() => setState('idle')}>Reset</button>
          </div>
        </div>
      )}
    </div>
  );
}
