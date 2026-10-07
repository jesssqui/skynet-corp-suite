import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

// A QR code as SVG (dark modules on white, with the standard 4-module quiet zone; always
// light so phone cameras read it in dark mode too). qrcode-generator: MIT, no dependencies.
export function Qr({ text, size = 196, label = 'QR code' }) {
  const { path, total } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { path: d, total: n + quiet * 2 };
  }, [text]);

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      style={{ display: 'block', borderRadius: 'var(--radius-sm)' }}
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
