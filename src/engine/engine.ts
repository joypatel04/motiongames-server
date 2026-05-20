import type { ITileDriver } from '@/drivers/driver.interface.js';
import type { Grid } from '@/engine/grid.js';
import type { Difficulty, IGame, Player, PlayerScore } from '@/games/game.interface.js';
import { GameEventEmitter } from '@/engine/events.js';
import { GameTimer } from '@/engine/timer.js';

export type EngineState = 'idle' | 'loaded' | 'running' | 'paused' | 'completed';

export interface EngineOptions {
  driver: ITileDriver;
  grid: Grid;
  emitter?: GameEventEmitter;
  tickIntervalMs?: number;
  now?: () => number;
  autoTick?: boolean; // when false, caller drives ticks manually (tests)
}

export class GameEngine {
  readonly driver: ITileDriver;
  readonly grid: Grid;
  readonly emitter: GameEventEmitter;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  private readonly autoTick: boolean;

  private game: IGame | null = null;
  private players: Player[] = [];
  private difficulty: Difficulty = 'medium';
  private state: EngineState = 'idle';
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private timer: GameTimer | null = null;

  constructor(options: EngineOptions) {
    this.driver = options.driver;
    this.grid = options.grid;
    this.emitter = options.emitter ?? new GameEventEmitter();
    this.tickIntervalMs = options.tickIntervalMs ?? 16;
    this.now = options.now ?? (() => Date.now());
    this.autoTick = options.autoTick ?? true;

    this.driver.onSensorEvent((tileIndex, pressed) => {
      this.emitter.emit(pressed ? 'tile_pressed' : 'tile_released', { tileIndex });
      if (this.state === 'running' && this.game) {
        this.game.onSensorEvent(tileIndex, pressed);
      }
    });
  }

  getState(): EngineState {
    return this.state;
  }

  getGame(): IGame | null {
    return this.game;
  }

  getTimer(): GameTimer | null {
    return this.timer;
  }

  loadGame(game: IGame, players: Player[], difficulty: Difficulty): void {
    if (this.state === 'running' || this.state === 'paused') {
      throw new Error('Cannot load a game while one is running');
    }
    if (players.length < game.minPlayers || players.length > game.maxPlayers) {
      throw new Error(
        `Game ${game.id} requires ${game.minPlayers}-${game.maxPlayers} players, got ${players.length}`,
      );
    }
    this.game = game;
    this.players = players;
    this.difficulty = difficulty;
    game.init(this.grid, players, difficulty);
    this.timer = new GameTimer({ durationMs: game.defaultDuration, now: this.now });
    this.state = 'loaded';
    this.emitter.emit('game_loaded', {
      gameId: game.id,
      players: players.length,
      difficulty,
    });
  }

  start(): void {
    if (!this.game || !this.timer) throw new Error('No game loaded');
    if (this.state === 'running') return;
    this.state = 'running';
    this.lastTickAt = this.now();
    this.timer.start();
    this.emitter.emit('game_start', { gameId: this.game.id });
    if (this.autoTick) {
      this.tickHandle = setInterval(() => this.tickOnce(), this.tickIntervalMs);
    }
  }

  pause(): void {
    if (this.state !== 'running' || !this.game || !this.timer) return;
    this.state = 'paused';
    this.timer.pause();
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.emitter.emit('game_pause', { gameId: this.game.id });
  }

  resume(): void {
    if (this.state !== 'paused' || !this.game || !this.timer) return;
    this.state = 'running';
    this.lastTickAt = this.now();
    this.timer.resume();
    this.emitter.emit('game_resume', { gameId: this.game.id });
    if (this.autoTick) {
      this.tickHandle = setInterval(() => this.tickOnce(), this.tickIntervalMs);
    }
  }

  stop(reason: 'finished' | 'stopped' | 'error' = 'stopped'): void {
    if (this.state === 'idle' || this.state === 'completed') return;
    const game = this.game;
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.timer) this.timer.stop();
    this.state = 'completed';
    if (game) {
      this.emitter.emit('game_end', { gameId: game.id, reason });
    }
  }

  /** Run a single tick; useful for tests. Returns true if the game finished. */
  tickOnce(deltaMsOverride?: number): boolean {
    if (this.state !== 'running' || !this.game || !this.timer) return false;
    const t = this.now();
    const delta = deltaMsOverride ?? Math.max(0, t - this.lastTickAt);
    this.lastTickAt = t;

    const result = this.game.tick(delta);
    if (result.tileUpdates.length > 0) {
      this.driver.setBatchTiles(result.tileUpdates);
    }
    for (const ev of result.events) {
      if (ev.type === 'score_update' && ev.payload) {
        const p = ev.payload as Record<string, unknown>;
        this.emitter.emit('score_update', {
          playerIndex: Number(p.playerIndex ?? 0),
          score: Number(p.score ?? 0),
          total: Number(p.total ?? 0),
        });
      }
    }
    this.emitter.emit('tick', {
      elapsedMs: this.timer.elapsedMs(),
      remainingMs: this.timer.remainingMs(),
    });

    if (result.finished || this.timer.isExpired()) {
      this.stop('finished');
      return true;
    }
    return false;
  }

  getScores(): PlayerScore[] {
    return this.game ? this.game.getScores() : [];
  }

  reset(): void {
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.game) this.game.cleanup();
    this.game = null;
    this.players = [];
    this.timer = null;
    this.state = 'idle';
  }

  getPlayers(): Player[] {
    return [...this.players];
  }

  getDifficulty(): Difficulty {
    return this.difficulty;
  }
}
