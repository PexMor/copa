import { useEffect, useRef } from 'preact/hooks';
import QRCode from 'qrcode';

interface Props {
  keyStr: string;
  onClose: () => void;
}

export function KeyQRModal({ keyStr, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, keyStr, { width: 280, margin: 1 }).catch(() => {});
  }, [keyStr]);

  return (
    <div class="scanner-overlay" onClick={onClose}>
      <div class="scanner-card" onClick={(e) => e.stopPropagation()}>
        <p class="scanner-label">AES key (Base58) — scan from peer device</p>
        <canvas ref={canvasRef} class="key-qr-canvas" />
        <button class="btn-sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
