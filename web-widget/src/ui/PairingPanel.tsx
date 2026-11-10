import { useEffect, useRef, useState } from 'preact/hooks';
import { CopaAuthError, type AuthState, type PairingAttempt, type PairingCapable } from '../auth';

/** QR code of `text` as an inline SVG (generated locally; loaded only when a key is shown). */
function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import('qrcode-generator').then((m) => {
      const qr = m.default(0, 'M');
      qr.addData(text);
      qr.make();
      if (live) setSvg(qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true }));
    }, () => undefined);
    return () => { live = false; };
  }, [text]);
  // the markup comes from our own generator, from a base64url string we produced
  return svg ? <div class="copa-qr" data-role="qr" aria-label="QR code of this device's public key" dangerouslySetInnerHTML={{ __html: svg }} /> : null;
}

interface Props {
  provider: PairingCapable;
  auth: AuthState;
  onError: (error: unknown) => void;
}

/** Code entry for SPAKE2; fingerprint + waiting for ECDH. Shown while the device is not paired. */
export function PairingPanel({ provider, auth, onError }: Props) {
  const [input, setInput] = useState('');
  const [attempt, setAttempt] = useState<PairingAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CopaAuthError | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const ecdh = provider.protocol === 'ecdh';

  const start = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const a = await provider.beginPairing(input);
      if (live.current) setAttempt(a);
      await a.done;
      if (live.current) { setInput(''); setAttempt(null); }
    } catch (err) {
      if (!live.current) return;
      const ce = err instanceof CopaAuthError ? err : new CopaAuthError('sign-in-failed', String(err));
      setError(ce);
      setAttempt(null);
      if (ce.code !== 'cancelled') onError(err);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <section class="copa-pairing" aria-label="Pair this device" data-protocol={provider.protocol}>
      {auth === 'expired' && !attempt && !error && (
        <div class="copa-muted" role="status" data-role="pairing-ended">The pairing of this device ended. Pair it again to continue.</div>
      )}
      <form onSubmit={start}>
        <label class="copa-muted" for="copa-pair-code">{ecdh ? 'Pairing code (from the operator)' : 'Pairing code'}</label>
        <div class="copa-row">
          <input
            id="copa-pair-code"
            class="copa-input"
            data-role="pair-input"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            placeholder={ecdh ? 'K7QF2M' : 'K7QF2M-48217730'}
            value={input}
            disabled={busy}
            onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
          />
          <button type="submit" class="primary" data-action="pair" disabled={busy || input.trim() === ''}>Pair</button>
        </div>
      </form>
      {attempt?.fingerprint && (
        <div data-role="fingerprint-box">
          <div class="copa-muted">Compare these digits with the operator's screen. If they differ, press Cancel.</div>
          <div class="copa-preview" data-role="fingerprint" aria-live="polite">{attempt.fingerprint}</div>
          {attempt.publicKey && <QrCode text={attempt.publicKey} />}
          <div class="copa-row">
            <span class="copa-muted" role="status" data-role="waiting-approval">Waiting for the operator to approve…</span>
            <span class="copa-spacer" />
            <button type="button" data-action="cancel-pairing" onClick={() => attempt.cancel()}>Cancel</button>
          </div>
        </div>
      )}
      {error && (
        <div class={error.code === 'cancelled' ? 'copa-muted' : 'copa-error'} role={error.code === 'cancelled' ? 'status' : 'alert'}
          data-role="pairing-error" data-code={error.code}>{error.message}</div>
      )}
    </section>
  );
}
