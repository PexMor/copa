import { useEffect, useRef, useState } from 'preact/hooks';
import mqtt, { MqttClient } from 'mqtt';
import type { MqttServer } from '../types';
import { encrypt, decrypt } from '../utils/crypto';
import type { WsStatus } from './useWebSocket';

interface UseMqttOpts {
  server: MqttServer | null;
  enabled: boolean;
  onMessage: (content: string) => void;
}

interface UseMqttResult {
  status: WsStatus;
  disconnect: () => void;
  publish: (text: string) => Promise<{ error?: string }>;
}

export function useMqtt({ server, enabled, onMessage }: UseMqttOpts): UseMqttResult {
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const clientRef = useRef<MqttClient | null>(null);
  const serverRef = useRef(server);
  serverRef.current = server;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const disconnect = () => {
    clientRef.current?.end(true);
    clientRef.current = null;
    setStatus('disconnected');
  };

  const publish = async (text: string): Promise<{ error?: string }> => {
    const srv = serverRef.current;
    if (!srv) return { error: 'No MQTT server configured' };
    if (!srv.aesKey) return { error: 'No AES key configured' };

    let envelope;
    try {
      envelope = await encrypt(text, srv.aesKey);
    } catch (e) {
      return { error: `Encryption failed: ${(e as Error).message}` };
    }

    const payload = JSON.stringify(envelope);
    if (payload.length > srv.maxMessageSize) {
      return { error: `Message too large (${payload.length} > ${srv.maxMessageSize} bytes)` };
    }

    const client = clientRef.current;
    if (!client) return { error: 'Not connected' };

    return new Promise((resolve) => {
      client.publish(srv.topic, payload, { retain: true, qos: 1 }, (err) => {
        if (err) resolve({ error: err.message });
        else resolve({});
      });
    });
  };

  useEffect(() => {
    if (!enabled || !server) {
      disconnect();
      return;
    }

    let cancelled = false;
    setStatus('connecting');

    const clientId = server.clientId || `copa_${Math.random().toString(36).slice(2)}`;
    const client = mqtt.connect(server.brokerUrl, {
      clientId,
      clean: true,
      reconnectPeriod: 3000,
    });
    clientRef.current = client;

    client.on('connect', () => {
      if (cancelled) { client.end(true); return; }
      setStatus('connected');
      client.subscribe(server.topic, { qos: 1 });
    });

    client.on('message', (_topic, message) => {
      if (cancelled) return;
      const srv = serverRef.current;
      if (!srv?.aesKey) return;
      const raw = message.toString();
      decrypt(raw, srv.aesKey)
        .then((plaintext) => { if (!cancelled) onMessageRef.current(plaintext); })
        .catch((err: Error) => {
          if (err.message !== 'not-copa-mqtt') {
            console.warn('Copa MQTT: failed to decrypt message:', err.message);
          }
        });
    });

    client.on('error', (err) => {
      console.error('Copa MQTT error:', err.message);
    });

    client.on('close', () => {
      if (!cancelled) setStatus('disconnected');
    });

    client.on('reconnect', () => {
      if (!cancelled) setStatus('connecting');
    });

    return () => {
      cancelled = true;
      client.end(true);
      clientRef.current = null;
      setStatus('disconnected');
    };
  }, [server?.id, enabled]);

  return { status, disconnect, publish };
}
