import { useState } from 'preact/hooks';
import type { CopaSession } from '../session';

interface Props {
  session: CopaSession;
  /** Share the text (routes to the clipboard endpoint or, when too large, to a file). */
  onShare: (text: string) => Promise<unknown>;
  /** Reports pull failures; share failures are reported by `onShare` itself. */
  onError: (error: unknown) => void;
}

export function TextPanel({ session, onShare, onError }: Props) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>, report: boolean) => {
    setBusy(true);
    setMsg(null);
    try { await fn(); } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      if (report) onError(e);
    } finally { setBusy(false); }
  };

  const push = () => run(async () => {
    await onShare(text);
    setMsg({ kind: 'ok', text: 'Pushed' });
  }, false);
  const pull = () => run(async () => {
    setText(await session.pull());
    setMsg({ kind: 'ok', text: 'Pulled' });
  }, true);

  const limit = session.sizeLimit;
  return (
    <section class="copa-text" aria-label="Text">
      <textarea
        aria-label="Clipboard text"
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        placeholder="Text to share"
      />
      <div class="copa-row">
        {session.canWrite && (
          <button type="button" class="primary" data-action="push" disabled={busy || text === ''} onClick={push}>Push</button>
        )}
        {session.canRead && (
          <button type="button" data-action="pull" disabled={busy} onClick={pull}>Pull</button>
        )}
        <span class="copa-spacer" />
        {limit !== undefined && <span class="copa-muted">limit {limit} bytes</span>}
      </div>
      {msg && <div role="status" class={msg.kind === 'ok' ? 'copa-ok' : 'copa-error'}>{msg.text}</div>}
    </section>
  );
}
