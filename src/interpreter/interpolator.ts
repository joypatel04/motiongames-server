import { lerp, lerpColor } from './color-hex.js';
import type { Easing } from './types/timeline.types.js';

export function easeFn(easing: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'linear':
      return x;
    case 'ease-in':
      return x * x;
    case 'ease-out':
      return 1 - (1 - x) * (1 - x);
    case 'ease-in-out':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'step':
      return x < 1 ? 0 : 1;
    default:
      return x;
  }
}

export function interpolateColor(a: string, b: string, t: number, easing: Easing = 'linear'): string {
  return lerpColor(a, b, easeFn(easing, t));
}

export function interpolateBrightness(a: number, b: number, t: number, easing: Easing = 'linear'): number {
  return lerp(a, b, easeFn(easing, t));
}
