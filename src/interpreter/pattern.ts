import type { Pattern } from './types/timeline.types.js';
import { rgbToHex } from './color-hex.js';

export interface PatternInput {
  color: string;
  brightness: number;
  pattern: Pattern;
  patternSpeed: number;
  time: number;
}

export interface PatternOutput {
  color: string;
  brightness: number;
}

/**
 * Apply a pattern animation transform to a base color/brightness.
 * `time` is absolute seconds from the keyframe's start (already aligned).
 * `patternSpeed` is in Hz (cycles per second); 0 falls back to 1 Hz so a
 * keyframe with pattern but no explicit speed still visibly animates.
 */
export function applyPattern({
  color,
  brightness,
  pattern,
  patternSpeed,
  time,
}: PatternInput): PatternOutput {
  const speed = patternSpeed > 0 ? patternSpeed : 1;
  switch (pattern) {
    case 'solid':
      return { color, brightness };
    case 'blink': {
      // 50% duty cycle on/off at `speed` Hz.
      const phase = (time * speed) % 1;
      return phase < 0.5
        ? { color, brightness }
        : { color, brightness: 0 };
    }
    case 'pulse': {
      // Brightness sinusoid: 0..1 over `1/speed` seconds.
      const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * speed * time);
      return { color, brightness: brightness * wave };
    }
    case 'rainbow': {
      // Hue cycle ignoring the base color.
      const hue = (time * speed * 360) % 360;
      return { color: hslToHex(hue, 1, 0.5), brightness };
    }
    case 'chase':
      // Chase is handled at the track level (depends on multiple tiles), so
      // a per-tile chase just behaves like solid here.
      return { color, brightness };
    default:
      return { color, brightness };
  }
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = l - c / 2;
  return rgbToHex({
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  });
}
