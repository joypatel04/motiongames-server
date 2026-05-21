import type { Grid } from '@/engine/grid.js';
import type {
  Difficulty,
  GameEvent,
  GameTickResult,
  IGame,
  Player,
  PlayerScore,
} from './game.interface.js';
import type { TileUpdate } from '@/drivers/driver.interface.js';
import {
  GameInterpreter,
  hexToRgb,
  DEFAULT_TILE_COLOR,
} from '@/interpreter/index.js';
import type { GameDefinition } from '@/interpreter/types/game-definition.js';
import type { GameState } from '@/interpreter/trigger-evaluator.js';

/**
 * Bridges a JSON GameDefinition (published from the designer) into the
 * server's IGame interface. Uses the full GameInterpreter engine ported
 * from motiongames-designer to evaluate triggers, execute actions, and
 * produce per-tile color updates each tick.
 */
export class JsonGameAdapter implements IGame {
  readonly id: string;
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultDuration: number;

  private readonly definition: GameDefinition;
  private interpreter!: GameInterpreter;
  private gameState!: GameState;
  private elapsedMs = 0;
  private endTriggeredAt: number | null = null;
  private players: Player[] = [];
  private grid!: Grid;
  /** Tracks the last color sent per tile so we only emit diffs. */
  private lastTileColors: Map<number, string> = new Map();

  constructor(definition: GameDefinition) {
    this.definition = definition;
    this.id = (definition as unknown as { slug?: string }).slug ?? definition.id ?? 'json-game';
    this.name = definition.name ?? this.id;
    this.minPlayers = definition.players?.min ?? 1;
    this.maxPlayers = definition.players?.max ?? 8;
    this.defaultDuration = (definition.duration?.seconds ?? 60) * 1000;
  }

  init(grid: Grid, players: Player[], difficulty: Difficulty): void {
    this.grid = grid;
    this.elapsedMs = 0;
    this.endTriggeredAt = null;
    this.players = players;
    this.lastTileColors = new Map();

    // Create a grid-adapted copy of the definition that matches the
    // actual hardware grid, not the grid the game was designed on.
    const adapted: GameDefinition = {
      ...this.definition,
      grid: { rows: grid.rows, cols: grid.cols },
    };

    this.interpreter = new GameInterpreter(adapted);

    // Map IGame difficulty ('easy'|'medium'|'hard') to the designer's
    // preset key. Fall through to the raw string if no mapping needed.
    this.gameState = this.interpreter.buildInitialGameState(difficulty);

    // Seed scores for all players.
    for (const p of players) {
      const key = `player${p.index + 1}`;
      if (!(key in this.gameState.scores)) {
        this.gameState.scores[key] = 0;
      }
    }

    // Restrict active players to those actually playing.
    this.gameState.activePlayers = players.map((p) => `player${p.index + 1}`);
  }

  tick(deltaMs: number): GameTickResult {
    this.elapsedMs += deltaMs;
    const events: GameEvent[] = [];
    const deltaSec = deltaMs / 1000;

    // Advance game time.
    this.gameState.time += deltaSec;

    // Run the interpreter's time-tick pass (triggers, spawns, phases, etc.).
    if (!this.gameState.ended) {
      this.interpreter.processTimeTick(this.gameState);

      // Check built-in win condition.
      const winChange = this.interpreter.checkWinCondition(this.gameState);
      if (winChange) {
        events.push({ type: 'win_condition', payload: winChange as unknown as Record<string, unknown> });
      }

      // Check duration-based end.
      if (this.interpreter.isGameOver(this.gameState)) {
        this.gameState.ended = true;
      }
    }

    // Get the full tile state from the interpreter.
    const frameState = this.interpreter.getFrameState(this.gameState.time, this.gameState);

    // Diff against last frame to produce only changed tiles.
    const tileUpdates: TileUpdate[] = [];
    for (const tile of frameState) {
      const color = tile.brightness < 1
        ? dimHexColor(tile.color, tile.brightness)
        : tile.color;
      const prev = this.lastTileColors.get(tile.index);
      if (prev !== color) {
        const rgb = hexToRgb(color);
        tileUpdates.push({ index: tile.index, r: rgb.r, g: rgb.g, b: rgb.b });
        this.lastTileColors.set(tile.index, color);
      }
    }

    // Handle game-over phase delay.
    if (this.gameState.ended) {
      if (this.endTriggeredAt === null) {
        this.endTriggeredAt = this.elapsedMs;
        events.push({ type: 'game_ended' });
      }
      // Give a 3-second celebration window before signaling finished.
      const GAME_OVER_DELAY_MS = 3000;
      if (this.elapsedMs - this.endTriggeredAt > GAME_OVER_DELAY_MS) {
        return { tileUpdates, finished: true, events };
      }
    }

    return { tileUpdates, finished: false, events };
  }

  onSensorEvent(tileIndex: number, pressed: boolean): void {
    if (this.gameState.ended) return;
    if (pressed) {
      this.interpreter.processSensorEvent(tileIndex, this.gameState);
    } else {
      this.interpreter.processSensorRelease(tileIndex, this.gameState);
    }
  }

  getScores(): PlayerScore[] {
    return this.players.map((p) => {
      const key = `player${p.index + 1}`;
      return {
        playerIndex: p.index,
        name: p.name,
        score: this.gameState.scores[key] ?? 0,
      };
    });
  }

  getState(): Record<string, unknown> {
    return {
      elapsedMs: this.elapsedMs,
      ended: this.gameState.ended,
      endOutcome: this.gameState.endOutcome,
      currentPhaseIndex: this.gameState.currentPhaseIndex,
      phaseStartedAt: this.gameState.phaseStartedAt,
      endTriggeredAt: this.endTriggeredAt,
      scores: { ...this.gameState.scores },
      activeSpawnCount: Object.keys(this.gameState.activeSpawns).length,
    };
  }

  cleanup(): void {
    this.elapsedMs = 0;
    this.endTriggeredAt = null;
    this.lastTileColors.clear();
  }

  // ── Test helpers ──────────────────────────────────────────────────
  getElapsedMs(): number {
    return this.elapsedMs;
  }
  getEndTriggeredAt(): number | null {
    return this.endTriggeredAt;
  }
  getGameState(): GameState {
    return this.gameState;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Apply brightness dimming to a hex color. */
function dimHexColor(hex: string, brightness: number): string {
  if (brightness >= 1) return hex;
  if (brightness <= 0) return '#000000';
  const rgb = hexToRgb(hex);
  const r = Math.round(rgb.r * brightness);
  const g = Math.round(rgb.g * brightness);
  const b = Math.round(rgb.b * brightness);
  const c = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
