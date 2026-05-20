import type { Grid } from '@/engine/grid.js';
import { BLACK, YELLOW, playerColor } from '@/utils/color.js';
import type { TileUpdate } from '@/drivers/driver.interface.js';
import type {
  Difficulty,
  GameEvent,
  GameTickResult,
  IGame,
  Player,
  PlayerScore,
} from './game.interface.js';

interface DifficultySettings {
  visibleMs: number;
  minDistance: number;
}

const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: { visibleMs: 2500, minDistance: 1 },
  medium: { visibleMs: 1500, minDistance: 3 },
  hard: { visibleMs: 900, minDistance: 5 },
};

interface PlayerStateInternal {
  index: number;
  name: string;
  score: number;
  captures: number;
  streak: number;
  bestStreak: number;
}

export class RaceToLight implements IGame {
  readonly id = 'race-to-light';
  readonly name = 'Race to Light';
  readonly minPlayers = 1;
  readonly maxPlayers = 4;
  readonly defaultDuration: number;

  private grid!: Grid;
  private players: PlayerStateInternal[] = [];
  private settings: DifficultySettings = DIFFICULTY.medium;
  private targetTile = -1;
  private targetRemaining = 0;
  private lastCapturePlayer = -1;
  private elapsed = 0;
  private duration = 60_000;
  private readonly rng: () => number;

  constructor(opts: { rng?: () => number; durationMs?: number } = {}) {
    this.rng = opts.rng ?? Math.random;
    this.duration = opts.durationMs ?? 60_000;
    this.defaultDuration = this.duration;
  }

  init(grid: Grid, players: Player[], difficulty: Difficulty): void {
    this.grid = grid;
    this.players = players.map((p) => ({
      index: p.index,
      name: p.name,
      score: 0,
      captures: 0,
      streak: 0,
      bestStreak: 0,
    }));
    this.settings = DIFFICULTY[difficulty];
    this.targetTile = this.pickNewTarget(-1);
    this.targetRemaining = this.settings.visibleMs;
    this.elapsed = 0;
    this.lastCapturePlayer = -1;
  }

  tick(deltaMs: number): GameTickResult {
    this.elapsed += deltaMs;
    const tileUpdates: TileUpdate[] = [];
    const events: GameEvent[] = [];

    this.targetRemaining -= deltaMs;
    if (this.targetRemaining <= 0) {
      // Target expired, pick a new one
      if (this.targetTile !== -1) {
        tileUpdates.push({ index: this.targetTile, r: BLACK.r, g: BLACK.g, b: BLACK.b });
      }
      this.targetTile = this.pickNewTarget(this.targetTile);
      this.targetRemaining = this.settings.visibleMs;
    }
    // Always paint the current target
    tileUpdates.push({ index: this.targetTile, r: YELLOW.r, g: YELLOW.g, b: YELLOW.b });

    return {
      tileUpdates,
      finished: this.elapsed >= this.duration,
      events,
    };
  }

  onSensorEvent(tileIndex: number, pressed: boolean): void {
    if (!pressed) return;
    if (tileIndex !== this.targetTile) return;
    // Rotate which player gets credit (simple competitive model)
    const nextPlayer = (this.lastCapturePlayer + 1) % Math.max(1, this.players.length);
    const player = this.players[nextPlayer];
    if (!player) return;
    player.captures++;
    player.streak = this.lastCapturePlayer === nextPlayer ? player.streak + 1 : 1;
    if (player.streak > player.bestStreak) player.bestStreak = player.streak;
    const bonus = player.streak >= 3 ? 5 : 0;
    player.score += 10 + bonus;
    this.lastCapturePlayer = nextPlayer;

    // Reset streaks for others
    for (const p of this.players) if (p.index !== player.index) p.streak = 0;

    // Move target immediately
    this.targetTile = this.pickNewTarget(this.targetTile);
    this.targetRemaining = this.settings.visibleMs;
  }

  getScores(): PlayerScore[] {
    return this.players.map((p) => ({
      playerIndex: p.index,
      name: p.name,
      score: p.score,
      stats: {
        captures: p.captures,
        bestStreak: p.bestStreak,
      },
    }));
  }

  getState(): Record<string, unknown> {
    return {
      elapsed: this.elapsed,
      targetTile: this.targetTile,
      players: this.players.map((p) => ({ ...p })),
    };
  }

  cleanup(): void {
    this.players = [];
  }

  /** Suppress unused import warning – exported for variety if extended later. */
  static playerColorOf(index: number) {
    return playerColor(index);
  }

  private pickNewTarget(previous: number): number {
    for (let attempt = 0; attempt < 50; attempt++) {
      const idx = Math.floor(this.rng() * this.grid.tileCount);
      if (idx === previous) continue;
      if (previous === -1 || this.grid.distance(idx, previous) >= this.settings.minDistance) {
        return idx;
      }
    }
    return Math.floor(this.rng() * this.grid.tileCount);
  }
}
