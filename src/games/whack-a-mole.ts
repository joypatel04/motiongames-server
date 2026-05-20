import type { Grid } from '@/engine/grid.js';
import { BLACK, GREEN, playerColor, type RGB } from '@/utils/color.js';
import type { TileUpdate } from '@/drivers/driver.interface.js';
import type {
  Difficulty,
  GameEvent,
  GameTickResult,
  IGame,
  Player,
  PlayerScore,
} from './game.interface.js';

interface Mole {
  tileIndex: number;
  remainingMs: number;
  color: RGB;
  ownerPlayer: number | null; // which player it counts for; null = any (single-player)
}

interface WhackOptions {
  rng?: () => number;
  durationMs?: number;
}

interface DifficultySettings {
  activeMoles: number;
  visibleMs: number;
  spawnIntervalMs: number;
}

const DIFFICULTY: Record<Difficulty, DifficultySettings> = {
  easy: { activeMoles: 2, visibleMs: 2500, spawnIntervalMs: 1200 },
  medium: { activeMoles: 3, visibleMs: 1800, spawnIntervalMs: 900 },
  hard: { activeMoles: 5, visibleMs: 1200, spawnIntervalMs: 600 },
};

export class WhackAMole implements IGame {
  readonly id = 'whack-a-mole';
  readonly name = 'Whack-a-Mole';
  readonly minPlayers = 1;
  readonly maxPlayers = 4;
  readonly defaultDuration: number;

  private grid!: Grid;
  private players: Player[] = [];
  private settings: DifficultySettings = DIFFICULTY.medium;
  private moles: Mole[] = [];
  private occupied = new Set<number>();
  private scores: number[] = [];
  private hits: number[] = [];
  private misses: number[] = [];
  private spawnCooldown = 0;
  private elapsed = 0;
  private duration = 60_000;
  private readonly rng: () => number;

  constructor(opts: WhackOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.duration = opts.durationMs ?? 60_000;
    this.defaultDuration = this.duration;
  }

  init(grid: Grid, players: Player[], difficulty: Difficulty): void {
    this.grid = grid;
    this.players = players;
    this.settings = DIFFICULTY[difficulty];
    this.moles = [];
    this.occupied.clear();
    this.scores = players.map(() => 0);
    this.hits = players.map(() => 0);
    this.misses = players.map(() => 0);
    this.spawnCooldown = 0;
    this.elapsed = 0;
  }

  tick(deltaMs: number): GameTickResult {
    this.elapsed += deltaMs;
    const tileUpdates: TileUpdate[] = [];
    const events: GameEvent[] = [];

    // Expire moles
    const remaining: Mole[] = [];
    for (const mole of this.moles) {
      mole.remainingMs -= deltaMs;
      if (mole.remainingMs <= 0) {
        tileUpdates.push({ index: mole.tileIndex, r: BLACK.r, g: BLACK.g, b: BLACK.b });
        this.occupied.delete(mole.tileIndex);
      } else {
        remaining.push(mole);
      }
    }
    this.moles = remaining;

    // Spawn new moles
    this.spawnCooldown -= deltaMs;
    while (this.spawnCooldown <= 0 && this.moles.length < this.settings.activeMoles) {
      const idx = this.findFreeTile();
      if (idx === -1) break;
      const color = this.players.length > 1 ? playerColor(this.moles.length % this.players.length) : GREEN;
      const owner = this.players.length > 1 ? this.moles.length % this.players.length : null;
      const mole: Mole = {
        tileIndex: idx,
        remainingMs: this.settings.visibleMs,
        color,
        ownerPlayer: owner,
      };
      this.moles.push(mole);
      this.occupied.add(idx);
      tileUpdates.push({ index: idx, r: color.r, g: color.g, b: color.b });
      this.spawnCooldown += this.settings.spawnIntervalMs;
    }
    if (this.spawnCooldown < 0) this.spawnCooldown = 0;

    return {
      tileUpdates,
      finished: this.elapsed >= this.duration,
      events,
    };
  }

  onSensorEvent(tileIndex: number, pressed: boolean): void {
    if (!pressed) return;
    const moleIdx = this.moles.findIndex((m) => m.tileIndex === tileIndex);
    if (moleIdx === -1) {
      // miss — penalize player 0 for solo; pick player index 0 by default
      const p = 0;
      this.scores[p] = (this.scores[p] ?? 0) - 5;
      this.misses[p] = (this.misses[p] ?? 0) + 1;
      return;
    }
    const mole = this.moles[moleIdx];
    if (!mole) return;
    const p = mole.ownerPlayer ?? 0;
    this.scores[p] = (this.scores[p] ?? 0) + 10;
    this.hits[p] = (this.hits[p] ?? 0) + 1;
    this.moles.splice(moleIdx, 1);
    this.occupied.delete(mole.tileIndex);
  }

  getScores(): PlayerScore[] {
    return this.players.map((player, i) => ({
      playerIndex: player.index,
      name: player.name,
      score: this.scores[i] ?? 0,
      stats: {
        hits: this.hits[i] ?? 0,
        misses: this.misses[i] ?? 0,
      },
    }));
  }

  getState(): Record<string, unknown> {
    return {
      elapsed: this.elapsed,
      duration: this.duration,
      activeMoles: this.moles.length,
      scores: [...this.scores],
    };
  }

  cleanup(): void {
    this.moles = [];
    this.occupied.clear();
  }

  private findFreeTile(): number {
    if (this.occupied.size >= this.grid.tileCount) return -1;
    for (let attempt = 0; attempt < 50; attempt++) {
      const idx = Math.floor(this.rng() * this.grid.tileCount);
      if (!this.occupied.has(idx)) return idx;
    }
    for (const i of this.grid.allTiles()) {
      if (!this.occupied.has(i)) return i;
    }
    return -1;
  }
}
