import { useCallback, useState } from 'preact/hooks';
import type { Capabilities, CopaServer, UploadState } from '../types';
import { apiFor } from '../utils/api';
import { uploadFile } from '../../../web-core/src';

// Re-exported for existing importers.
export { CORS_HINT } from '../../../web-core/src';

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
    setUploads((prev) => [...prev, { key, name: file.name, loaded: 0, total: file.size }]);
    try {
      await uploadFile(apiFor(server, namespace), file, caps, (loaded) => patch(key, { loaded }));
      dismiss(key);
      onDone(file.name);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'upload failed';
      patch(key, { error: message });
      onError(`${file.name}: ${message}`);
    }
  };

  /** Each file becomes its own history item. */
  const upload = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) void uploadOne(file);
  }, [server?.id, server?.url, server?.token, namespace, caps]);

  return { uploads, upload, dismiss };
}
