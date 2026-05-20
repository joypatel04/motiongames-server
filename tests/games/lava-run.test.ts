import { describe, it, expect } from 'vitest';
import { LavaRun } from '@/games/lava-run.js';
import { Grid } from '@/engine/grid.js';

function makeRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe('LavaRun', () => {
  it('produces tile updates and tracks survival time', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new LavaRun({ rng: makeRng(3), durationMs: 5000 });
    game.init(grid, [{ index: 0, name: 'a' }], 'easy');
    const r = game.tick(100);
    expect(r.tileUpdates.length).toBeGreaterThan(0);
    expect(game.getScores()[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it('reaching the end zone awards bonus points', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new LavaRun({ rng: makeRng(11), durationMs: 5000 });
    game.init(grid, [{ index: 0, name: 'a' }], 'easy');
    game.tick(50);
    const endTile = grid.tileIndex(grid.rows - 1, 0);
    game.onSensorEvent(endTile, true);
    const score = game.getScores()[0]!.score;
    expect(score).toBeGreaterThanOrEqual(100);
  });

  it('stepping on lava kills the player', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new LavaRun({ rng: makeRng(11), durationMs: 5000 });
    game.init(grid, [{ index: 0, name: 'a' }], 'easy');
    game.tick(50);
    // Row 0 has lava seeded; index 0 is row 0 col 0
    game.onSensorEvent(grid.tileIndex(0, 0), true);
    const state = game.getState() as { players: Array<{ alive: boolean }> };
    expect(state.players[0]!.alive).toBe(false);
  });
});
