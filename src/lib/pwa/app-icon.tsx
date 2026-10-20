import { ImageResponse } from "next/og";

/**
 * Brand mark used by the PWA manifest, the Apple touch icon and the
 * notification icon. Mirrors `src/app/icon.tsx` (Hostinger violet
 * square + white chat-square glyph) but scales the glyph and stroke
 * proportionally so it stays crisp at 180/192/512.
 *
 * Deliberately full-bleed (no rounded corners): iOS and Android apply
 * their own mask to Home Screen icons, and a maskable icon must not
 * carry transparency at the edges.
 */
export function renderAppIcon(size: number) {
  const glyph = Math.round(size * 0.625);
  const stroke = Math.max(2, Math.round(size * 0.078));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7c3aed",
        }}
      >
        <svg
          width={glyph}
          height={glyph}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
