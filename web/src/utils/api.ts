import { CopaApi, downloadViaAnchor } from '../../../web-core/src';
import { recheckAfterFailure } from './access';
import type { Capabilities, CopaServer, HistoryItem } from '../types';

// The HTTP client lives in web-core (shared with the embeddable widget); this
// module binds it to the app's static-token servers and the identity-proxy gate.
export { ApiError, formatRemaining, formatSize } from '../../../web-core/src';
export type { UploadGrant } from '../../../web-core/src';

export function apiHeaders(server: CopaServer, namespace: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${server.token}`,
    'X-Copa-Namespace': namespace,
  };
}

export function apiFor(server: CopaServer, namespace: string): CopaApi {
  return new CopaApi({
    baseUrl: server.url,
    namespace,
    getHeader: () => `Bearer ${server.token}`,
    onFailure: () => recheckAfterFailure(server.url),
  });
}

/** null when the server predates history/files (no capability endpoint). */
export function fetchCapabilities(server: CopaServer, namespace: string): Promise<Capabilities | null> {
  return apiFor(server, namespace).capabilities();
}

export function fetchHistory(server: CopaServer, namespace: string): Promise<HistoryItem[]> {
  return apiFor(server, namespace).history();
}

export function fetchItemText(server: CopaServer, namespace: string, id: string): Promise<string> {
  return apiFor(server, namespace).itemText(id);
}

export function deleteItem(server: CopaServer, namespace: string, id: string): Promise<void> {
  return apiFor(server, namespace).deleteItem(id);
}

/**
 * Ask for a fresh presigned URL and hand it straight to the browser.
 * The URL is used once and never stored.
 */
export async function downloadFile(server: CopaServer, namespace: string, id: string): Promise<void> {
  const info = await apiFor(server, namespace).fileDownload(id);
  downloadViaAnchor(info.download_url);
}
