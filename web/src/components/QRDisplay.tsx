import { useEffect, useRef, useState } from 'preact/hooks';
import QRCode from 'qrcode';

const URL_RE = /^(https?:\/\/|geo:)/i;

interface Props {
  content: string;
}

export function QRDisplay({ content }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');

  const isUrl = URL_RE.test(content.trim());

  useEffect(() => {
    if (isUrl) setVisible(true);
    else setVisible(false);
  }, [isUrl]);

  useEffect(() => {
    if (!visible || !content || !canvasRef.current) return;
    setError('');
    QRCode.toCanvas(canvasRef.current, content.trim(), { width: 220, margin: 1 })
      .catch(() => setError('QR generation failed'));
  }, [visible, content]);

  if (!content) return null;

  return (
    <div class="qr-section">
      {!visible && (
        <button class="btn-sm" onClick={() => setVisible(true)}>Show QR</button>
      )}
      {visible && (
        <div class="qr-wrap">
          <button class="btn-sm" onClick={() => setVisible(false)}>Hide QR</button>
          {error ? <p class="err">{error}</p> : <canvas ref={canvasRef} />}
        </div>
      )}
    </div>
  );
}
