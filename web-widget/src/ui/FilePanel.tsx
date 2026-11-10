import { useRef, useState } from 'preact/hooks';
import type { CopaSession } from '../session';
import { formatSize } from '../core';

export interface UploadRow { key: string; name: string; loaded: number; total: number; error?: string }

interface Props {
  session: CopaSession;
  uploads: UploadRow[];
  onFiles: (files: File[]) => void;
  onDismiss: (key: string) => void;
}

/** Drop zone + picker + upload progress. Pasting is handled on the widget root. */
export function FilePanel({ session, uploads, onFiles, onDismiss }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const max = session.maxFileSize;
  return (
    <section class="copa-files" aria-label="Files">
      <div
        class="copa-drop"
        data-over={over}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
          if (files.length) onFiles(files);
        }}
      >
        Drop files here or{' '}
        <button type="button" data-action="pick" onClick={() => input.current?.click()}>choose files</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-role="file-input"
          onChange={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            if (el.files?.length) onFiles(Array.from(el.files));
            el.value = '';
          }}
        />
        {max !== undefined && <div class="copa-muted">up to {formatSize(max)} each</div>}
      </div>
      {uploads.length > 0 && (
        <ul aria-label="Uploads">
          {uploads.map((u) => (
            <li class="copa-item" key={u.key} data-error={u.error ? 'true' : 'false'}>
              <div class="copa-row">
                <span>{u.name}</span>
                <span class="copa-spacer" />
                {u.error
                  ? <button type="button" onClick={() => onDismiss(u.key)}>Dismiss</button>
                  : <span class="copa-muted">{formatSize(u.loaded)} / {formatSize(u.total)}</span>}
              </div>
              {u.error
                ? <div class="copa-error" role="alert">{u.error}</div>
                : <progress max={u.total} value={u.loaded} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
