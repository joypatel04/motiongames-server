import { describe, it, expect } from 'vitest';
import { GameEngine } from '@/engine/engine.js';
import { Grid } from '@/engine/grid.js';
import { MockDriver } from '@/drivers/mock.driver.js';
import type { Difficulty, IGame, Player, PlayerScore } from '@/games/game.interface.js';

class FakeGame implements IGame {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly minPlayers = 1;
  readonly maxPlayers = 4;
  readonly defaultDuration = 1000;

  ticks = 0;
  sensorEvents: Array<[number, boolean]> = [];
  cleanedUp = false;
  scores: PlayerScore[] = [];

  init(_grid: unknown, players: Player[], _difficulty: Difficulty): void {
    this.scores = players.map((p) => ({ playerIndex: p.index, name: p.name, score: 0 }));
  }
  tick(_deltaMs: number) {
    this.ticks++;
    return {
      tileUpdates: [{ index: 0, r: this.ticks, g: 0, b: 0 }],
      finished: this.ticks >= 3,
      events: [],
    };
  }
  onSensorEvent(tileIndex: number, pressed: boolean) {
    this.sensorEvents.push([tileIndex, pressed]);
  }
  getScores(): PlayerScore[] {
    return this.scores;
  }
  getState() {
    return { ticks: this.ticks };
  }
  cleanup() {
    this.cleanedUp = true;
  }
}

function makeEngine(): { engine: GameEngine; driver: MockDriver; game: FakeGame } {
  const driver = new MockDriver({ tileCount: 16 });
  const grid = new Grid({ rows: 4, cols: 4 });
  const engine = new GameEngine({ driver, grid, autoTick: false });
  const game = new FakeGame();
  return { engine, driver, game };
}

describe('GameEngine', () => {
  it('loads, starts, ticks, and completes', () => {
    const { engine, driver, game } = makeEngine();
    expect(engine.getState()).toBe('idle');
    engine.loadGame(game, [{ index: 0, name: 'p1' }], 'medium');
    expect(engine.getState()).toBe('loaded');
    engine.start();
    expect(engine.getState()).toBe('running');
    expect(engine.tickOnce(10)).toBe(false);
    expect(engine.tickOnce(10)).toBe(false);
    expect(engine.tickOnce(10)).toBe(true); // 3rd tick → finished
    expect(engine.getState()).toBe('completed');
    expect(driver.getTileColor(0).r).toBe(3);
  });

  it('pauses and resumes', () => {
    const { engine, game } = makeEngine();
    engine.loadGame(game, [{ index: 0, name: 'p1' }], 'easy');
    engine.start();
    engine.pause();
    expect(engine.getState()).toBe('paused');
    expect(engine.tickOnce()).toBe(false); // ignored while paused
    engine.resume();
    expect(engine.getState()).toBe('running');
  });

  it('routes sensor events to active game only when running', () => {
    const { engine, driver, game } = makeEngine();
    engine.loadGame(game, [{ index: 0, name: 'p1' }], 'medium');
    driver.pressTile(5); // engine loaded, not running
    expect(game.sensorEvents).toEqual([]);
    engine.start();
    driver.pressTile(7);
    driver.releaseTile(7);
    expect(game.sensorEvents).toEqual([
      [7, true],
      [7, false],
    ]);
  });

  it('emits engine events', () => {
    const { engine, game } = makeEngine();
    const calls: string[] = [];
    engine.emitter.on('game_loaded', () => calls.push('loaded'));
    engine.emitter.on('game_start', () => calls.push('start'));
    engine.emitter.on('game_end', () => calls.push('end'));
    engine.loadGame(game, [{ index: 0, name: 'p1' }], 'hard');
    engine.start();
    engine.tickOnce();
    engine.tickOnce();
    engine.tickOnce();
    expect(calls).toEqual(['loaded', 'start', 'end']);
  });

  it('rejects player counts outside game bounds', () => {
    const { engine, game } = makeEngine();
    expect(() => engine.loadGame(game, [], 'medium')).toThrow();
    const five: Player[] = Array.from({ length: 5 }, (_, i) => ({ index: i, name: `p${i}` }));
    expect(() => engine.loadGame(game, five, 'medium')).toThrow();
  });

  it('reset cleans up game state', () => {
    const { engine, game } = makeEngine();
    engine.loadGame(game, [{ index: 0, name: 'p1' }], 'medium');
    engine.reset();
    expect(engine.getState()).toBe('idle');
    expect(game.cleanedUp).toBe(true);
  });
});
