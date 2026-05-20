import type { Grid } from '@/engine/grid.js';
import type { TileUpdate } from '@/drivers/driver.interface.js';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Player {
  index: number;
  name: string;
}

export interface PlayerScore {
  playerIndex: number;
  name: string;
  score: number;
  rank?: number;
  isWinner?: boolean;
  stats?: Record<string, number | string>;
}

export interface GameEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface GameTickResult {
  tileUpdates: TileUpdate[];
  finished: boolean;
  events: GameEvent[];
}

export interface IGame {
  readonly id: string;
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultDuration: number; // milliseconds

  init(grid: Grid, players: Player[], difficulty: Difficulty): void;
  tick(deltaMs: number): GameTickResult;
  onSensorEvent(tileIndex: number, pressed: boolean): void;
  getScores(): PlayerScore[];
  getState(): Record<string, unknown>;
  cleanup(): void;
}
