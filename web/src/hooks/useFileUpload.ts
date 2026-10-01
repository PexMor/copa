import { useCallback, useState } from 'preact/hooks';
import type { Capabilities, CopaServer, UploadState } from '../types';
import { ApiError, completeUpload, formatSize, requestUpload, type UploadGrant } from '../utils/api';

/** Shown when the PUT dies before any HTTP response — almost always bucket CORS. */
export const CORS_HINT =
  'Upload was blocked before reaching the object store. The bucket CORS policy probably does not allow this origin '
  + `(${typeof location !== 'undefined' ? location.origin : 'this site'}) — see docs/FILES.md, "Troubleshooting".`;

function putToStore(grant: UploadGrant, file: File, onProgress: (loaded: number) => void): Promise<void> {
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
    xhr.send(file);
  });
}

interface UseFileUploadOpts {
  server: CopaServer | null;
  namespace: string;
  caps: Capabilities | null;
  onDone: (name: string) => void;
  onError: (message: string) => void;
}

export function useFileUpload({ server, namespace, caps, onDone, onError }: UseFileUploadOpts) {
  const [uploads, setUploads] = useState<UploadState[]>([]);

  const patch = (key: string, change: Partial<UploadState>) =>
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...change } : u)));
  const dismiss = useCallback((key: string) => setUploads((prev) => prev.filter((u) => u.key !== key)), []);

  const uploadOne = async (file: File) => {
    if (!server || !caps?.files) return;
    const key = Math.random().toString(36).slice(2);
    const fail = (message: string) => {
      patch(key, { error: message });
      onError(`${file.name}: ${message}`);
    };
    setUploads((prev) => [...prev, { key, name: file.name, loaded: 0, total: file.size }]);

    if (file.size === 0) { fail('file is empty'); return; }
    if (caps.max_file_size !== undefined && file.size > caps.max_file_size) {
      fail(`too large — the limit is ${formatSize(caps.max_file_size)}`);
      return;
    }
    try {
      const grant = await requestUpload(server, namespace, file);
      await putToStore(grant, file, (loaded) => patch(key, { loaded }));
      await completeUpload(server, namespace, grant.id);
      dismiss(key);
      onDone(file.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 413) fail('too large for this server');
      else if (e instanceof ApiError && e.status === 507) fail('storage quota of this namespace is full');
      else fail(e instanceof Error ? e.message : 'upload failed');
    }
  };

  /** Each file becomes its own history item. */
  const upload = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) void uploadOne(file);
  }, [server?.id, server?.url, server?.token, namespace, caps]);

  return { uploads, upload, dismiss };
}
