import { useEffect, useState } from 'preact/hooks';
import type { Capabilities, CopaServer } from '../types';
import { fetchCapabilities } from '../utils/api';

/** Capabilities of the selected copa server + namespace; null for older servers and MQTT. */
export function useCapabilities(server: CopaServer | null, namespace: string): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    setCaps(null);
    if (!server) return;
    let cancelled = false;
    // debounce: the namespace is a free-text input
    const timer = setTimeout(() => {
      fetchCapabilities(server, namespace).then((c) => { if (!cancelled) setCaps(c); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [server?.id, server?.url, server?.token, namespace]);

  return caps;
}
