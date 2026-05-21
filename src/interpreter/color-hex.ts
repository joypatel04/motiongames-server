export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * The "off" / default color a tile shows when nothing else is painting it.
 * Used by the engine, the store, and the UI — keeping it here means there's
 * one place to change the visual default.
 */
export const DEFAULT_TILE_COLOR = '#1f2937';

export function hexToRgb(hex: string): RGB {
  const cleaned = hex.replace('#', '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return { r: 0, g: 0, b: 0 };
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: lerp(ca.r, cb.r, t),
    g: lerp(ca.g, cb.g, t),
    b: lerp(ca.b, cb.b, t),
  });
}

export function isValidHex(hex: string): boolean {
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(hex);
}

export function normalizeHex(hex: string): string {
  if (!hex.startsWith('#')) hex = '#' + hex;
  return hex.toLowerCase();
}
