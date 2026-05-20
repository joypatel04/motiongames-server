import type { Grid } from '@/engine/grid.js';
import type {
  Difficulty,
  GameEvent,
  GameTickResult,
  IGame,
  Player,
  PlayerScore,
} from './game.interface.js';

/**
 * Minimal slice of a published GameDefinition that the adapter needs. The
 * full type lives in the to-be-ported designer interpreter; this is the
 * subset that drives the high-level tick/lifecycle behavior.
 */
export interface JsonGameDefinition {
  id?: string;
  name?: string;
  slug?: string;
  duration?: { seconds?: number };
  players?: { min?: number; max?: number };
  phases?: JsonGamePhase[];
  timeline?: { phases?: JsonGamePhase[] };
}

export interface JsonGamePhase {
  id?: string;
  name?: string;
  /** Duration in SECONDS (matching designer phase definitions). */
  duration?: number;
}

export interface JsonGameAdapterState {
  ended: boolean;
  /** Index into the resolved phases array. */
  currentPhaseIndex: number;
  /** Phase start time in SECONDS since game start (matching designer state). */
  phaseStartedAt: number;
  /** Final scores keyed by player index — populated when ended=true. */
  scores: Record<number, number>;
}

const DEFAULT_GAME_OVER_PHASE_DURATION_SEC = 5;
const FALLBACK_END_DELAY_MS = 2000;

/**
 * Bridges a JSON GameDefinition (published from the designer) into the
 * server's IGame interface. The full interpreter (zone resolver, trigger
 * evaluator, action executor) lands in STR-9; this adapter implements the
 * lifecycle envelope around it and — critically — the game-over phase delay
 * so the winner celebration animation plays out on the floor before the
 * engine marks the session finished.
 */
export class JsonGameAdapter implements IGame {
  readonly id: string;
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultDuration: number;

  private readonly definition: JsonGameDefinition;
  private elapsedMs = 0;
  private endTriggeredAt: number | null = null;
  private gameState: JsonGameAdapterState = {
    ended: false,
    currentPhaseIndex: 0,
    phaseStartedAt: 0,
    scores: {},
  };
  private players: Player[] = [];

  constructor(definition: JsonGameDefinition) {
    this.definition = definition;
    this.id = definition.slug ?? definition.id ?? 'json-game';
    this.name = definition.name ?? this.id;
    this.minPlayers = definition.players?.min ?? 1;
    this.maxPlayers = definition.players?.max ?? 8;
    this.defaultDuration = (definition.duration?.seconds ?? 60) * 1000;
  }

  init(_grid: Grid, players: Player[], _difficulty: Difficulty): void {
    this.elapsedMs = 0;
    this.endTriggeredAt = null;
    this.players = players;
    this.gameState = {
      ended: false,
      currentPhaseIndex: 0,
      phaseStartedAt: 0,
      scores: Object.fromEntries(players.map((p) => [p.index, 0])),
    };
  }

  /**
   * Externally signal the game has ended (winner determined). Once called,
   * `tick()` will continue running until either the game_over phase finishes
   * or the 2s fallback delay elapses, then return `finished: true`.
   */
  endGame(scoresByPlayerIndex?: Record<number, number>): void {
    if (this.gameState.ended) return;
    this.gameState.ended = true;
    if (scoresByPlayerIndex) this.gameState.scores = { ...scoresByPlayerIndex };
    const phases = this.resolvePhases();
    const gameOverIdx = phases.findIndex(isGameOverPhase);
    if (gameOverIdx >= 0) {
      this.gameState.currentPhaseIndex = gameOverIdx;
      this.gameState.phaseStartedAt = this.elapsedMs / 1000;
    } else {
      this.endTriggeredAt = this.elapsedMs;
    }
  }

  tick(deltaMs: number): GameTickResult {
    this.elapsedMs += deltaMs;
    const events: GameEvent[] = [];
    // The full interpreter will populate tileUpdates; the skeleton has none.
    const tileUpdates: GameTickResult['tileUpdates'] = [];

    if (!this.gameState.ended) {
      // Without a real interpreter, the only natural end-of-game signal is
      // the configured duration. Real interpreter wiring (STR-9) will call
      // endGame() based on win conditions instead.
      if (this.elapsedMs >= this.defaultDuration) this.endGame();
    }

    if (this.gameState.ended) {
      const phases = this.resolvePhases();
      const currentPhase = phases[this.gameState.currentPhaseIndex];

      if (currentPhase && isGameOverPhase(currentPhase)) {
        const phaseElapsed = this.elapsedMs - this.gameState.phaseStartedAt * 1000;
        const phaseDuration =
          (currentPhase.duration ?? DEFAULT_GAME_OVER_PHASE_DURATION_SEC) * 1000;
        if (phaseElapsed >= phaseDuration) {
          return { tileUpdates, finished: true, events };
        }
      } else {
        if (this.endTriggeredAt === null) this.endTriggeredAt = this.elapsedMs;
        if (this.elapsedMs - this.endTriggeredAt > FALLBACK_END_DELAY_MS) {
          return { tileUpdates, finished: true, events };
        }
      }
    }

    return { tileUpdates, finished: false, events };
  }

  onSensorEvent(_tileIndex: number, _pressed: boolean): void {
    // No-op until interpreter is ported.
  }

  getScores(): PlayerScore[] {
    return this.players.map((p) => ({
      playerIndex: p.index,
      name: p.name,
      score: this.gameState.scores[p.index] ?? 0,
    }));
  }

  getState(): Record<string, unknown> {
    return {
      elapsedMs: this.elapsedMs,
      ended: this.gameState.ended,
      currentPhaseIndex: this.gameState.currentPhaseIndex,
      phaseStartedAt: this.gameState.phaseStartedAt,
      endTriggeredAt: this.endTriggeredAt,
    };
  }

  cleanup(): void {
    this.elapsedMs = 0;
    this.endTriggeredAt = null;
    this.gameState = {
      ended: false,
      currentPhaseIndex: 0,
      phaseStartedAt: 0,
      scores: {},
    };
  }

  // Test helpers — package-private use only.
  getElapsedMs(): number {
    return this.elapsedMs;
  }
  getEndTriggeredAt(): number | null {
    return this.endTriggeredAt;
  }

  private resolvePhases(): JsonGamePhase[] {
    return this.definition.phases ?? this.definition.timeline?.phases ?? [];
  }
}

function isGameOverPhase(p: JsonGamePhase): boolean {
  return p.id === 'game_over' || p.name === 'game_over';
}
