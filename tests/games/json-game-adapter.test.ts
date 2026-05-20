import { describe, it, expect } from 'vitest';
import { JsonGameAdapter, type JsonGameDefinition } from '@/games/json-game-adapter.js';
import { Grid } from '@/engine/grid.js';

const grid = new Grid({ rows: 4, cols: 4, serpentine: false });
const players = [
  { index: 0, name: 'Alice' },
  { index: 1, name: 'Bob' },
];

function makeAdapter(def: Partial<JsonGameDefinition>): JsonGameAdapter {
  const adapter = new JsonGameAdapter({
    id: 'test',
    name: 'Test',
    slug: 'test',
    duration: { seconds: 1 },
    players: { min: 1, max: 4 },
    ...def,
  });
  adapter.init(grid, players, 'medium');
  return adapter;
}

describe('JsonGameAdapter', () => {
  it('exposes the IGame metadata derived from the definition', () => {
    const adapter = makeAdapter({
      duration: { seconds: 60 },
      players: { min: 1, max: 4 },
    });
    expect(adapter.id).toBe('test');
    expect(adapter.minPlayers).toBe(1);
    expect(adapter.maxPlayers).toBe(4);
    expect(adapter.defaultDuration).toBe(60_000);
  });

  it('does not finish immediately when gameState.ended is set — game_over phase plays out', () => {
    const adapter = makeAdapter({
      duration: { seconds: 1 },
      phases: [
        { id: 'play', duration: 1 },
        { id: 'game_over', duration: 3 },
      ],
    });

    // Tick to end of play phase — duration expires, game_over phase begins.
    const r1 = adapter.tick(1000);
    expect(r1.finished).toBe(false);
    expect((adapter.getState() as { ended: boolean }).ended).toBe(true);

    // 1s into game_over — still not finished.
    const r2 = adapter.tick(1000);
    expect(r2.finished).toBe(false);

    // 2s into game_over — still not finished.
    const r3 = adapter.tick(1000);
    expect(r3.finished).toBe(false);

    // 3s into game_over — celebration done.
    const r4 = adapter.tick(1000);
    expect(r4.finished).toBe(true);
  });

  it('uses the 2s fallback delay when no game_over phase exists', () => {
    const adapter = makeAdapter({
      duration: { seconds: 1 },
      // No game_over phase.
      phases: [{ id: 'play', duration: 1 }],
    });

    // Reach end of play phase.
    const r1 = adapter.tick(1000);
    expect(r1.finished).toBe(false);
    expect((adapter.getState() as { ended: boolean }).ended).toBe(true);
    expect(adapter.getEndTriggeredAt()).toBe(1000);

    // 1s after end — still inside the 2s fallback window.
    const r2 = adapter.tick(1000);
    expect(r2.finished).toBe(false);

    // Just past 2s — fallback expires.
    const r3 = adapter.tick(1500);
    expect(r3.finished).toBe(true);
  });

  it('honors an explicitly-triggered endGame() with celebration delay', () => {
    const adapter = makeAdapter({
      duration: { seconds: 60 },
      phases: [
        { name: 'play', duration: 60 },
        { name: 'game_over', duration: 4 },
      ],
    });

    // Player taps an end-condition trigger after 10s.
    adapter.tick(10_000);
    adapter.endGame({ 0: 12, 1: 7 });
    expect((adapter.getState() as { ended: boolean }).ended).toBe(true);

    // Phase should be game_over now.
    expect((adapter.getState() as { currentPhaseIndex: number }).currentPhaseIndex).toBe(1);

    // 3s in — not finished yet.
    const r1 = adapter.tick(3000);
    expect(r1.finished).toBe(false);

    // Cross the 4s phase duration.
    const r2 = adapter.tick(1500);
    expect(r2.finished).toBe(true);

    // Scores carried over.
    const scores = adapter.getScores();
    expect(scores.find((s) => s.name === 'Alice')?.score).toBe(12);
    expect(scores.find((s) => s.name === 'Bob')?.score).toBe(7);
  });

  it('defaults game_over phase duration to 5s when unspecified', () => {
    const adapter = makeAdapter({
      duration: { seconds: 1 },
      phases: [{ id: 'play', duration: 1 }, { id: 'game_over' }],
    });

    adapter.tick(1000); // play ends
    // 4s into game_over — still going.
    const r1 = adapter.tick(4000);
    expect(r1.finished).toBe(false);
    // 5s reached.
    const r2 = adapter.tick(1000);
    expect(r2.finished).toBe(true);
  });

  it('supports phases nested under timeline.phases', () => {
    const adapter = makeAdapter({
      duration: { seconds: 1 },
      timeline: { phases: [{ id: 'play', duration: 1 }, { id: 'game_over', duration: 2 }] },
    });
    adapter.tick(1000); // play ends → game_over begins
    expect(adapter.tick(1000).finished).toBe(false);
    expect(adapter.tick(1500).finished).toBe(true);
  });

  it('cleanup resets all transient state', () => {
    const adapter = makeAdapter({ duration: { seconds: 1 } });
    adapter.tick(1500);
    adapter.cleanup();
    expect(adapter.getElapsedMs()).toBe(0);
    expect(adapter.getEndTriggeredAt()).toBeNull();
    expect((adapter.getState() as { ended: boolean }).ended).toBe(false);
  });
});
