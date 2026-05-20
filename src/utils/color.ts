export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

export const BLACK: RGB = { r: 0, g: 0, b: 0 };
export const WHITE: RGB = { r: 255, g: 255, b: 255 };
export const RED: RGB = { r: 255, g: 0, b: 0 };
export const GREEN: RGB = { r: 0, g: 255, b: 0 };
export const BLUE: RGB = { r: 0, g: 0, b: 255 };
export const YELLOW: RGB = { r: 255, g: 255, b: 0 };
export const CYAN: RGB = { r: 0, g: 255, b: 255 };
export const MAGENTA: RGB = { r: 255, g: 0, b: 255 };
export const ORANGE: RGB = { r: 255, g: 128, b: 0 };
export const PURPLE: RGB = { r: 128, g: 0, b: 255 };

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampByte(value: number): number {
  return Math.round(clamp(value, 0, 255));
}

export function rgb(r: number, g: number, b: number): RGB {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lum = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * lum - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lum - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) {
    r1 = c;
    g1 = x;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
  } else if (hue < 180) {
    g1 = c;
    b1 = x;
  } else if (hue < 240) {
    g1 = x;
    b1 = c;
  } else if (hue < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return rgb((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

export function rgbToHsl(color: RGB): HSL {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export function dim(color: RGB, factor: number): RGB {
  const f = clamp(factor, 0, 1);
  return rgb(color.r * f, color.g * f, color.b * f);
}

export function lerp(a: RGB, b: RGB, t: number): RGB {
  const u = clamp(t, 0, 1);
  return rgb(a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u);
}

export function equals(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

export const PLAYER_COLORS: RGB[] = [RED, BLUE, GREEN, YELLOW, MAGENTA, CYAN, ORANGE, PURPLE];

export function playerColor(playerIndex: number): RGB {
  const c = PLAYER_COLORS[playerIndex % PLAYER_COLORS.length];
  return c ?? RED;
}
