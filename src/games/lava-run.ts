import type { Grid } from '@/engine/grid.js';
import { ORANGE, RED, WHITE } from '@/utils/color.js';
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
  lavaSpreadIntervalMs: number;
  initialSafeRows: number;
}

const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: { lavaSpreadIntervalMs: 1800, initialSafeRows: 4 },
  medium: { lavaSpreadIntervalMs: 1200, initialSafeRows: 3 },
  hard: { lavaSpreadIntervalMs: 700, initialSafeRows: 2 },
};

interface PlayerStateInternal {
  index: number;
  name: string;
  alive: boolean;
  lastTile: number | null;
  reached: boolean;
  tilesVisited: number;
  survivedMs: number;
}

export class LavaRun implements IGame {
  readonly id = 'lava-run';
  readonly name = 'Lava Run';
  readonly minPlayers = 1;
  readonly maxPlayers = 4;
  readonly defaultDuration: number;

  private grid!: Grid;
  private players: PlayerStateInternal[] = [];
  private settings: DifficultySettings = DIFFICULTY.medium;
  private lava: Set<number> = new Set();
  private endRow = 0;
  private elapsed = 0;
  private spreadCooldown = 0;
  private duration = 90_000;
  private readonly rng: () => number;

  constructor(opts: { rng?: () => number; durationMs?: number } = {}) {
    this.rng = opts.rng ?? Math.random;
    this.duration = opts.durationMs ?? 90_000;
    this.defaultDuration = this.duration;
  }

  init(grid: Grid, players: Player[], difficulty: Difficulty): void {
    this.grid = grid;
    this.settings = DIFFICULTY[difficulty];
    this.elapsed = 0;
    this.spreadCooldown = this.settings.lavaSpreadIntervalMs;
    this.lava = new Set();
    this.endRow = grid.rows - 1;
    this.players = players.map((p) => ({
      index: p.index,
      name: p.name,
      alive: true,
      lastTile: null,
      reached: false,
      tilesVisited: 0,
      survivedMs: 0,
    }));
    // Seed initial lava in row 0
    for (let c = 0; c < grid.cols; c++) {
      if (c % 3 === 0) this.lava.add(grid.tileIndex(0, c));
    }
  }

  tick(deltaMs: number): GameTickResult {
    this.elapsed += deltaMs;
    const tileUpdates: TileUpdate[] = [];
    const events: GameEvent[] = [];

    // Lava spread
    this.spreadCooldown -= deltaMs;
    if (this.spreadCooldown <= 0) {
      this.spreadCooldown += this.settings.lavaSpreadIntervalMs;
      this.spreadLava(tileUpdates);
    }

    // Update alive players' survival time
    for (const p of this.players) {
      if (p.alive && !p.reached) p.survivedMs += deltaMs;
    }

    // Paint end zone
    for (let c = 0; c < this.grid.cols; c++) {
      const idx = this.grid.tileIndex(this.endRow, c);
      if (!this.lava.has(idx)) {
        tileUpdates.push({ index: idx, r: WHITE.r, g: WHITE.g, b: WHITE.b });
      }
    }

    const finished = this.players.every((p) => !p.alive || p.reached);
    return { tileUpdates, finished, events };
  }

  onSensorEvent(tileIndex: number, pressed: boolean): void {
    if (!pressed) return;
    // First eligible player handles the step; rotate by alive players
    const player = this.players.find((p) => p.alive && !p.reached);
    if (!player) return;
    const { row } = this.grid.tilePosition(tileIndex);
    if (this.lava.has(tileIndex)) {
      player.alive = false;
      return;
    }
    player.lastTile = tileIndex;
    player.tilesVisited++;
    if (row === this.endRow) {
      player.reached = true;
    }
  }

  getScores(): PlayerScore[] {
    return this.players.map((p) => ({
      playerIndex: p.index,
      name: p.name,
      score: p.tilesVisited * 5 + Math.floor(p.survivedMs / 1000) * 2 + (p.reached ? 100 : 0),
      stats: {
        tilesVisited: p.tilesVisited,
        survivedMs: p.survivedMs,
        reached: p.reached ? 1 : 0,
        alive: p.alive ? 1 : 0,
      },
    }));
  }

  getState(): Record<string, unknown> {
    return {
      elapsed: this.elapsed,
      lavaCount: this.lava.size,
      players: this.players.map((p) => ({ ...p })),
    };
  }

  cleanup(): void {
    this.lava.clear();
    this.players = [];
  }

  private spreadLava(updates: TileUpdate[]): void {
    const toAdd: number[] = [];
    for (const idx of this.lava) {
      for (const n of this.grid.neighbors(idx)) {
        if (!this.lava.has(n) && this.rng() < 0.35) toAdd.push(n);
      }
    }
    for (const i of toAdd) {
      this.lava.add(i);
      const c = this.rng() < 0.5 ? RED : ORANGE;
      updates.push({ index: i, r: c.r, g: c.g, b: c.b });
    }
    // Make sure all existing lava tiles painted
    for (const idx of this.lava) {
      updates.push({ index: idx, r: RED.r, g: RED.g, b: RED.b });
    }
  }
}
