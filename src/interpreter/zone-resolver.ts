import type { ZoneSelector } from './types/grid.types.js';

/**
 * Deterministic 32-bit hash over a string. Used to seed PRNGs from human-
 * readable seeds so `random_percent` selectors are stable across runs.
 */
function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Mulberry32 PRNG — small, fast, deterministic, no dependencies.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function idx(row: number, col: number, cols: number): number {
  return row * cols + col;
}

type AnchorPoint =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top-center'
  | 'bottom-center'
  | 'left-center'
  | 'right-center'
  | 'center';

function anchorToCoords(
  anchor: AnchorPoint,
  rows: number,
  cols: number
): { row: number; col: number } {
  switch (anchor) {
    case 'top-left':
      return { row: 0, col: 0 };
    case 'top-right':
      return { row: 0, col: cols - 1 };
    case 'bottom-left':
      return { row: rows - 1, col: 0 };
    case 'bottom-right':
      return { row: rows - 1, col: cols - 1 };
    case 'top-center':
      return { row: 0, col: Math.floor(cols / 2) };
    case 'bottom-center':
      return { row: rows - 1, col: Math.floor(cols / 2) };
    case 'left-center':
      return { row: Math.floor(rows / 2), col: 0 };
    case 'right-center':
      return { row: Math.floor(rows / 2), col: cols - 1 };
    case 'center':
      return { row: Math.floor(rows / 2), col: Math.floor(cols / 2) };
  }
}

function num(p: Record<string, unknown>, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(p: Record<string, unknown>, key: string, fallback: string): string {
  const v = p[key];
  return typeof v === 'string' ? v : fallback;
}

/**
 * Resolves a zone selector to actual tile indices for a given grid size.
 * This is the key function that makes games grid-adaptive.
 */
export function resolveZone(
  selector: ZoneSelector,
  rows: number,
  cols: number
): number[] {
  if (rows <= 0 || cols <= 0) return [];
  const p = selector.params ?? {};
  const result = new Set<number>();
  switch (selector.type) {
    case 'all': {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) result.add(idx(r, c, cols));
      }
      break;
    }
    case 'border': {
      const width = Math.max(1, Math.floor(num(p, 'width', 1)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const distRow = Math.min(r, rows - 1 - r);
          const distCol = Math.min(c, cols - 1 - c);
          if (Math.min(distRow, distCol) < width) result.add(idx(r, c, cols));
        }
      }
      break;
    }
    case 'center': {
      const percent = Math.max(0, Math.min(100, num(p, 'percent', 50))) / 100;
      // Square-ish centered patch sized to `percent` of total area.
      const targetCount = Math.max(1, Math.round(rows * cols * percent));
      const aspect = cols / rows;
      const innerRows = Math.max(1, Math.round(Math.sqrt(targetCount / aspect)));
      const innerCols = Math.max(1, Math.min(cols, Math.round(innerRows * aspect)));
      const finalInnerRows = Math.min(rows, innerRows);
      const startR = Math.floor((rows - finalInnerRows) / 2);
      const startC = Math.floor((cols - innerCols) / 2);
      for (let r = startR; r < startR + finalInnerRows; r++) {
        for (let c = startC; c < startC + innerCols; c++) {
          if (r >= 0 && r < rows && c >= 0 && c < cols) result.add(idx(r, c, cols));
        }
      }
      break;
    }
    case 'rows': {
      const from = Math.max(0, Math.floor(num(p, 'from', 0)));
      const count = Math.max(0, Math.floor(num(p, 'count', 1)));
      const anchor = str(p, 'anchor', 'top') as 'top' | 'bottom';
      const startRow = anchor === 'bottom' ? Math.max(0, rows - from - count) : from;
      for (let r = startRow; r < Math.min(rows, startRow + count); r++) {
        for (let c = 0; c < cols; c++) result.add(idx(r, c, cols));
      }
      break;
    }
    case 'cols': {
      const from = Math.max(0, Math.floor(num(p, 'from', 0)));
      const count = Math.max(0, Math.floor(num(p, 'count', 1)));
      const anchor = str(p, 'anchor', 'left') as 'left' | 'right';
      const startCol = anchor === 'right' ? Math.max(0, cols - from - count) : from;
      for (let c = startCol; c < Math.min(cols, startCol + count); c++) {
        for (let r = 0; r < rows; r++) result.add(idx(r, c, cols));
      }
      break;
    }
    case 'corners': {
      const size = Math.max(1, Math.floor(num(p, 'size', 1)));
      const corners: Array<{ r: number; c: number }> = [
        { r: 0, c: 0 },
        { r: 0, c: cols - size },
        { r: rows - size, c: 0 },
        { r: rows - size, c: cols - size },
      ];
      for (const corner of corners) {
        for (let r = corner.r; r < corner.r + size; r++) {
          for (let c = corner.c; c < corner.c + size; c++) {
            if (r >= 0 && r < rows && c >= 0 && c < cols) result.add(idx(r, c, cols));
          }
        }
      }
      break;
    }
    case 'random_percent': {
      const percent = Math.max(0, Math.min(100, num(p, 'percent', 25))) / 100;
      const seed = str(p, 'seed', 'default');
      const target = Math.max(0, Math.round(rows * cols * percent));
      const rand = mulberry32(hashString(`${seed}|${rows}x${cols}`));
      const all: number[] = [];
      for (let i = 0; i < rows * cols; i++) all.push(i);
      // Fisher–Yates shuffle for deterministic sampling.
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = all[i]!;
        const b = all[j]!;
        all[i] = b;
        all[j] = a;
      }
      for (let i = 0; i < Math.min(target, all.length); i++) result.add(all[i]!);
      break;
    }
    case 'quadrant': {
      const pos = str(p, 'position', 'top-left') as
        | 'top-left'
        | 'top-right'
        | 'bottom-left'
        | 'bottom-right';
      const halfR = Math.ceil(rows / 2);
      const halfC = Math.ceil(cols / 2);
      const rStart = pos.startsWith('bottom') ? rows - halfR : 0;
      const cStart = pos.endsWith('right') ? cols - halfC : 0;
      for (let r = rStart; r < rStart + halfR; r++) {
        for (let c = cStart; c < cStart + halfC; c++) {
          if (r >= 0 && r < rows && c >= 0 && c < cols) result.add(idx(r, c, cols));
        }
      }
      break;
    }
    case 'stripe': {
      const axis = str(p, 'axis', 'row') as 'row' | 'col';
      const interval = Math.max(1, Math.floor(num(p, 'interval', 2)));
      const offset = Math.max(0, Math.floor(num(p, 'offset', 0)));
      if (axis === 'row') {
        for (let r = offset; r < rows; r += interval) {
          for (let c = 0; c < cols; c++) result.add(idx(r, c, cols));
        }
      } else {
        for (let c = offset; c < cols; c += interval) {
          for (let r = 0; r < rows; r++) result.add(idx(r, c, cols));
        }
      }
      break;
    }
    case 'ring': {
      const distance = Math.max(0, Math.floor(num(p, 'distance', 0)));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const distRow = Math.min(r, rows - 1 - r);
          const distCol = Math.min(c, cols - 1 - c);
          if (Math.min(distRow, distCol) === distance) result.add(idx(r, c, cols));
        }
      }
      break;
    }
    case 'path': {
      const from = str(p, 'from', 'top-left') as AnchorPoint;
      const to = str(p, 'to', 'bottom-right') as AnchorPoint;
      const width = Math.max(1, Math.floor(num(p, 'width', 1)));
      const start = anchorToCoords(from, rows, cols);
      const end = anchorToCoords(to, rows, cols);
      // Bresenham-like line from start → end.
      const dx = Math.abs(end.col - start.col);
      const dy = Math.abs(end.row - start.row);
      const sx = start.col < end.col ? 1 : -1;
      const sy = start.row < end.row ? 1 : -1;
      let err = dx - dy;
      let r = start.row;
      let c = start.col;
      const half = Math.floor((width - 1) / 2);
      const extra = (width - 1) - half;
      const stamp = (cr: number, cc: number) => {
        for (let dr = -half; dr <= extra; dr++) {
          for (let dc = -half; dc <= extra; dc++) {
            const rr = cr + dr;
            const cc2 = cc + dc;
            if (rr >= 0 && rr < rows && cc2 >= 0 && cc2 < cols)
              result.add(idx(rr, cc2, cols));
          }
        }
      };
      stamp(r, c);
      while (r !== end.row || c !== end.col) {
        const e2 = 2 * err;
        if (e2 > -dy) {
          err -= dy;
          c += sx;
        }
        if (e2 < dx) {
          err += dx;
          r += sy;
        }
        stamp(r, c);
      }
      break;
    }
    case 'custom_expr': {
      const expr = str(p, 'expr', 'false');
      let fn: ((row: number, col: number, rows: number, cols: number) => unknown) | null;
      try {
        fn = new Function(
          'row',
          'col',
          'rows',
          'cols',
          `return (${expr});`
        ) as (row: number, col: number, rows: number, cols: number) => unknown;
      } catch {
        fn = null;
      }
      if (fn) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            try {
              if (fn(r, c, rows, cols)) result.add(idx(r, c, cols));
            } catch {
              // skip invalid evals
            }
          }
        }
      }
      break;
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

/**
 * Convenience helper: resolve the membership of multiple zones at a given
 * grid size. Each zone gets the resolved indices (selector wins if set).
 */
export function resolveZoneTiles(
  zone: { tiles: number[]; selector?: ZoneSelector },
  rows: number,
  cols: number
): number[] {
  if (zone.selector) return resolveZone(zone.selector, rows, cols);
  // V1 absolute indices — keep only those that exist on the current grid.
  const max = rows * cols;
  return zone.tiles.filter((i) => i >= 0 && i < max);
}
