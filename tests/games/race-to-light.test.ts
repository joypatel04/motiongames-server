import { describe, it, expect } from 'vitest';
import { RaceToLight } from '@/games/race-to-light.js';
import { Grid } from '@/engine/grid.js';

function makeRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

describe('RaceToLight', () => {
  it('lights one target at a time and captures on press', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new RaceToLight({ rng: makeRng(5), durationMs: 60_000 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    const r = game.tick(10);
    expect(r.tileUpdates.length).toBeGreaterThan(0);
    const state = game.getState() as { targetTile: number };
    game.onSensorEvent(state.targetTile, true);
    expect(game.getScores()[0]!.score).toBeGreaterThanOrEqual(10);
  });

  it('does not score on non-target press', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new RaceToLight({ rng: makeRng(5), durationMs: 60_000 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    game.tick(10);
    const state = game.getState() as { targetTile: number };
    const wrong = (state.targetTile + 1) % grid.tileCount;
    game.onSensorEvent(wrong, true);
    expect(game.getScores()[0]!.score).toBe(0);
  });

  it('finishes after duration', () => {
    const grid = new Grid({ rows: 4, cols: 4 });
    const game = new RaceToLight({ rng: makeRng(5), durationMs: 100 });
    game.init(grid, [{ index: 0, name: 'p1' }], 'easy');
    game.tick(60);
    const r = game.tick(60);
    expect(r.finished).toBe(true);
  });
});
