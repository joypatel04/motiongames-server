import { describe, it, expect } from 'vitest';
import { Grid } from '@/engine/grid.js';

describe('Grid', () => {
  it('computes linear tile index for row-major layout', () => {
    const g = new Grid({ rows: 4, cols: 3 });
    expect(g.tileIndex(0, 0)).toBe(0);
    expect(g.tileIndex(0, 2)).toBe(2);
    expect(g.tileIndex(1, 0)).toBe(3);
    expect(g.tileIndex(3, 2)).toBe(11);
    expect(g.tileCount).toBe(12);
  });

  it('round-trips index↔position', () => {
    const g = new Grid({ rows: 4, cols: 3 });
    for (let i = 0; i < g.tileCount; i++) {
      const p = g.tilePosition(i);
      expect(g.tileIndex(p.row, p.col)).toBe(i);
    }
  });

  it('serpentine reverses odd rows', () => {
    const g = new Grid({ rows: 2, cols: 3, serpentine: true });
    // row 0: 0,1,2
    expect(g.tileIndex(0, 0)).toBe(0);
    expect(g.tileIndex(0, 2)).toBe(2);
    // row 1 reversed: tiles 3,4,5 map to cols 2,1,0
    expect(g.tileIndex(1, 2)).toBe(3);
    expect(g.tileIndex(1, 1)).toBe(4);
    expect(g.tileIndex(1, 0)).toBe(5);
    // position round-trip
    expect(g.tilePosition(3)).toEqual({ row: 1, col: 2 });
    expect(g.tilePosition(5)).toEqual({ row: 1, col: 0 });
  });

  it('neighbors returns 4-directional neighbors only within bounds', () => {
    const g = new Grid({ rows: 3, cols: 3 });
    const center = g.tileIndex(1, 1);
    expect(g.neighbors(center).sort((a, b) => a - b)).toEqual(
      [g.tileIndex(0, 1), g.tileIndex(1, 0), g.tileIndex(1, 2), g.tileIndex(2, 1)].sort(
        (a, b) => a - b,
      ),
    );
    const corner = g.tileIndex(0, 0);
    expect(g.neighbors(corner).sort((a, b) => a - b)).toEqual(
      [g.tileIndex(0, 1), g.tileIndex(1, 0)].sort((a, b) => a - b),
    );
  });

  it('distance is Manhattan', () => {
    const g = new Grid({ rows: 4, cols: 4 });
    expect(g.distance(g.tileIndex(0, 0), g.tileIndex(3, 3))).toBe(6);
    expect(g.distance(g.tileIndex(1, 2), g.tileIndex(1, 2))).toBe(0);
  });

  it('isValid bounds check', () => {
    const g = new Grid({ rows: 2, cols: 2 });
    expect(g.isValid(0, 0)).toBe(true);
    expect(g.isValid(1, 1)).toBe(true);
    expect(g.isValid(-1, 0)).toBe(false);
    expect(g.isValid(0, 2)).toBe(false);
  });

  it('randomTile uses provided rng deterministically', () => {
    let seed = 0;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const g = new Grid({ rows: 4, cols: 4, rng });
    const a = g.randomTile();
    const b = g.randomTile();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(16);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(16);
  });

  it('allTiles yields every tile in order', () => {
    const g = new Grid({ rows: 2, cols: 3 });
    expect([...g.allTiles()]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
