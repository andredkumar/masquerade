/**
 * Deterministic color for an AI label, keyed by labelId.
 *
 * Mirrors `colorForLabelId` in server/services/frameAccess.ts so the swatch
 * shown in home.tsx's label list matches the bbox stroke color rendered
 * by the FrameViewer (which gets its color from the server's inference.json).
 *
 * Hash: FNV-1a → hue. Saturation/Lightness fixed for legibility against
 * both light and dark backgrounds.
 *
 * Keep in sync with the server-side function. If you change the constants
 * here, change them there too.
 */
export function colorForLabelId(labelId: string): string {
  let h = 2166136261;
  for (let i = 0; i < labelId.length; i++) {
    h ^= labelId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 72% 52%)`;
}
