import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code for the ntfy link, drawn locally from the text: nothing is sent anywhere to make it. The
 * quiet zone and the white ground stay in both themes, because a scanner needs the contrast.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { n, d };
  }, [text]);
  const size = cells.n + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-[208px] shrink-0 rounded-md"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.d} fill="#0b1220" />
    </svg>
  );
}
