import { ApiError, type CopaApi } from './api';
import { formatSize } from './format';
import type { Capabilities, HistoryItem, UploadGrant } from './types';

/** Shown when the PUT dies before any HTTP response — almost always bucket CORS. */
export const CORS_HINT =
  'Upload was blocked before reaching the object store. The bucket CORS policy probably does not allow this origin '
  + `(${typeof location !== 'undefined' ? location.origin : 'this site'}) — see docs/FILES.md, "Troubleshooting".`;

/** Transfer the bytes straight to the object store with the presigned grant. */
export function putToStore(grant: UploadGrant, body: Blob, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(grant.method, grant.upload_url);
    for (const [name, value] of Object.entries(grant.headers)) {
      // Content-Length is set by the browser from the body
      if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Object store rejected the upload (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(CORS_HINT));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.send(body);
  });
}

/** Human-readable failure of {@link uploadFile}. */
export class UploadFailure extends Error {}

/**
 * Whole upload flow: size checks → grant → direct transfer → completion.
 * Returns the stored item. Failures are thrown as {@link UploadFailure}.
 */
export async function uploadFile(
  api: CopaApi,
  file: File | Blob & { name?: string },
  caps: Pick<Capabilities, 'max_file_size'>,
  onProgress: (loaded: number) => void,
): Promise<HistoryItem> {
  if (file.size === 0) throw new UploadFailure('file is empty');
  if (caps.max_file_size !== undefined && file.size > caps.max_file_size) {
    throw new UploadFailure(`too large — the limit is ${formatSize(caps.max_file_size)}`);
  }
  try {
    const grant = await api.requestUpload({
      name: (file as File).name ?? 'clipboard',
      size: file.size,
      type: file.type,
    });
    await putToStore(grant, file, onProgress);
    return await api.completeUpload(grant.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 413) throw new UploadFailure('too large for this server');
    if (e instanceof ApiError && e.status === 507) throw new UploadFailure('storage quota of this namespace is full');
    throw new UploadFailure(e instanceof Error ? e.message : 'upload failed');
  }
}
