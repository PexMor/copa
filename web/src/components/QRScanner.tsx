import { useEffect, useRef } from 'preact/hooks';
import QrScanner from 'qr-scanner';

interface Props {
  onScan: (text: string) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  onScanRef.current = onScan;
  onCloseRef.current = onClose;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const scanner = new QrScanner(
      video,
      (result) => {
        scanner.stop();
        onScanRef.current(result.data);
        onCloseRef.current();
      },
      { preferredCamera: 'environment', highlightScanRegion: true, highlightCodeOutline: true },
    );
    scanner.start().catch(() => onCloseRef.current());
    return () => { scanner.stop(); scanner.destroy(); };
  }, []);

  return (
    <div class="scanner-overlay" onClick={onClose}>
      <div class="scanner-card" onClick={(e) => e.stopPropagation()}>
        <p class="scanner-label">Point camera at a QR code</p>
        <video ref={videoRef} class="scanner-video" />
        <button class="btn-sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
