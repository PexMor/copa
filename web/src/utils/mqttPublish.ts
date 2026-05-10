import mqtt from 'mqtt';
import type { MqttServer } from '../types';
import { encrypt } from './crypto';

export async function publishMqtt(server: MqttServer, text: string): Promise<{ error?: string }> {
  if (!server.aesKey) return { error: 'No AES key configured' };

  let envelope;
  try {
    envelope = await encrypt(text, server.aesKey);
  } catch (e) {
    return { error: `Encryption failed: ${(e as Error).message}` };
  }

  const payload = JSON.stringify(envelope);
  if (payload.length > server.maxMessageSize) {
    return { error: `Message too large (${payload.length} > ${server.maxMessageSize} bytes)` };
  }

  return new Promise((resolve) => {
    const clientId = `copa_${Math.random().toString(36).slice(2)}`;
    const client = mqtt.connect(server.brokerUrl, { clientId, clean: true, reconnectPeriod: 0 });

    const timeout = setTimeout(() => {
      client.end(true);
      resolve({ error: 'Connection timeout' });
    }, 10000);

    client.on('connect', () => {
      client.publish(server.topic, payload, { retain: true, qos: 1 }, (err) => {
        clearTimeout(timeout);
        client.end(true);
        if (err) resolve({ error: err.message });
        else resolve({});
      });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.end(true);
      resolve({ error: err.message });
    });
  });
}
