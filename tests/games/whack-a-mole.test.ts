import { describe, it, expect } from 'vitest';
import { WhackAMole } from '@/games/whack-a-mole.js';
import { Grid } from '@/engine/grid.js';

function makeRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe('WhackAMole', () => {
  it('spawns moles on tick, paints tiles, and finishes after duration', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new WhackAMole({ rng: makeRng(7), durationMs: 1000 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    const r = game.tick(50);
    expect(r.tileUpdates.length).toBeGreaterThan(0);
    expect(r.finished).toBe(false);

    // Run beyond duration
    for (let i = 0; i < 30; i++) game.tick(50);
    const last = game.tick(50);
    expect(last.finished).toBe(true);
  });

  it('scoring: hit on lit tile +10, miss on dark tile -5', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new WhackAMole({ rng: makeRng(7), durationMs: 60_000 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    const result = game.tick(10);
    const updates = result.tileUpdates.filter((u) => u.r + u.g + u.b > 0);
    expect(updates.length).toBeGreaterThan(0);
    const litTile = updates[0]!.index;
    game.onSensorEvent(litTile, true);
    expect(game.getScores()[0]!.score).toBe(10);
    // Miss: press a tile we know isn't lit
    let darkTile = -1;
    for (const i of grid.allTiles()) {
      if (!updates.some((u) => u.index === i)) {
        darkTile = i;
        break;
      }
    }
    expect(darkTile).toBeGreaterThanOrEqual(0);
    game.onSensorEvent(darkTile, true);
    expect(game.getScores()[0]!.score).toBe(5); // 10 - 5
  });

  it('release events do not score', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new WhackAMole({ rng: makeRng(2), durationMs: 60_000 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    game.tick(10);
    game.onSensorEvent(0, false);
    expect(game.getScores()[0]!.score).toBe(0);
  });
});
