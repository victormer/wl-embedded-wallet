import encodeQR from 'qr';

/** SVG with no inline styles or `data:` URLs, to comply with the CSP. The content never leaves the browser. */
export function QrCode({ text, label, testId }: { text: string; label: string; testId: string }) {
  const modules = encodeQR(text, 'raw', { ecc: 'medium', border: 4 });
  const path = modules
    .flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])))
    .join('');
  return (
    <svg className="qr" viewBox={`0 0 ${modules.length} ${modules.length}`} shapeRendering="crispEdges" role="img" aria-label={label} data-testid={testId}>
      <path d={path} />
    </svg>
  );
}
