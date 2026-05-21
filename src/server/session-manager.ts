import type { GameEngine } from '@/engine/engine.js';
import type { GamesRepository } from '@/db/repositories/games.repo.js';
import type { SessionsRepository, SessionRow } from '@/db/repositories/sessions.repo.js';
import type { ScoresRepository } from '@/db/repositories/scores.repo.js';
import type { LeaderboardRepository } from '@/db/repositories/leaderboard.repo.js';
import type { SyncQueueRepository } from '@/db/repositories/sync-queue.repo.js';
import { WhackAMole } from '@/games/whack-a-mole.js';
import { LavaRun } from '@/games/lava-run.js';
import { RaceToLight } from '@/games/race-to-light.js';
import { JsonGameAdapter } from '@/games/json-game-adapter.js';
import type { GameDefinition } from '@/interpreter/types/game-definition.js';
import type { Difficulty, IGame, Player, PlayerScore } from '@/games/game.interface.js';

export interface CreateSessionInput {
  gameSlug: string;
  players: string[]; // display names
  difficulty: Difficulty;
}

export interface SessionResult {
  sessionId: string;
  scores: PlayerScore[];
}

export interface SessionManagerDeps {
  engine: GameEngine;
  games: GamesRepository;
  sessions: SessionsRepository;
  scores: ScoresRepository;
  leaderboard: LeaderboardRepository;
  syncQueue: SyncQueueRepository;
  gameFactory?: (slug: string, definition: string | null) => IGame;
}

/**
 * Create an IGame instance for the given slug. Hardcoded games take
 * priority; if the slug doesn't match any built-in, fall back to the
 * JSON-driven interpreter via JsonGameAdapter when a `definition` is
 * available in the local game catalog.
 */
const DEFAULT_GAME_FACTORY = (slug: string, definition: string | null): IGame => {
  switch (slug) {
    case 'whack-a-mole':
      return new WhackAMole();
    case 'lava-run':
      return new LavaRun();
    case 'race-to-light':
      return new RaceToLight();
    default: {
      if (definition) {
        const def = JSON.parse(definition) as GameDefinition;
        return new JsonGameAdapter(def);
      }
      throw new Error(`Unknown game slug: ${slug}`);
    }
  }
};

export class SessionManager {
  private readonly engine: GameEngine;
  private readonly games: GamesRepository;
  private readonly sessions: SessionsRepository;
  private readonly scores: ScoresRepository;
  private readonly leaderboard: LeaderboardRepository;
  private readonly syncQueue: SyncQueueRepository;
  private readonly gameFactory: (slug: string, definition: string | null) => IGame;

  private currentSessionId: string | null = null;
  private currentPlayers: Player[] = [];
  private currentGameId: string | null = null;
  private sessionStartedAt = 0;

  constructor(deps: SessionManagerDeps) {
    this.engine = deps.engine;
    this.games = deps.games;
    this.sessions = deps.sessions;
    this.scores = deps.scores;
    this.leaderboard = deps.leaderboard;
    this.syncQueue = deps.syncQueue;
    this.gameFactory = deps.gameFactory ?? DEFAULT_GAME_FACTORY;

    this.engine.emitter.on('game_end', () => {
      if (this.engine.getState() === 'completed' && this.currentSessionId) {
        this.finalize();
      }
    });
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  createSession(input: CreateSessionInput): SessionRow {
    if (this.currentSessionId) {
      throw new Error('A session is already in progress');
    }
    const gameRow = this.games.getBySlug(input.gameSlug);
    if (!gameRow) throw new Error(`Unknown game: ${input.gameSlug}`);
    if (input.players.length === 0) throw new Error('At least one player required');

    const session = this.sessions.create({
      gameId: gameRow.id,
      playerCount: input.players.length,
      difficulty: input.difficulty,
    });
    this.currentSessionId = session.id;
    this.currentGameId = gameRow.id;
    this.currentPlayers = input.players.map((name, index) => ({ index, name }));

    const game = this.gameFactory(input.gameSlug, gameRow.definition);
    this.engine.loadGame(game, this.currentPlayers, input.difficulty);
    return session;
  }

  startGame(): void {
    if (!this.currentSessionId) throw new Error('No session loaded');
    this.sessions.markStarted(this.currentSessionId);
    this.sessionStartedAt = Date.now();
    this.engine.start();
  }

  pauseGame(): void {
    if (!this.currentSessionId) return;
    this.engine.pause();
    this.sessions.setStatus(this.currentSessionId, 'paused');
  }

  resumeGame(): void {
    if (!this.currentSessionId) return;
    this.engine.resume();
    this.sessions.setStatus(this.currentSessionId, 'active');
  }

  /** Stop the game manually; finalize will be triggered via game_end. */
  stopGame(): SessionResult | null {
    if (!this.currentSessionId) return null;
    this.engine.stop('stopped');
    return this.finalize();
  }

  /** Force finalize — extracted so manual stops and natural ends share code. */
  finalize(): SessionResult | null {
    if (!this.currentSessionId || !this.currentGameId) return null;
    const sessionId = this.currentSessionId;
    const gameId = this.currentGameId;
    const finalScores = this.engine.getScores();

    // Rank and mark winner
    const sorted = [...finalScores].sort((a, b) => b.score - a.score);
    const ranked = sorted.map((s, i) => ({ ...s, rank: i + 1, isWinner: i === 0 }));

    this.scores.insertBatch(
      ranked.map((s) => ({
        sessionId,
        displayName: s.name,
        score: s.score,
        rank: s.rank,
        isWinner: s.isWinner === true,
        stats: s.stats,
      })),
    );

    for (const s of ranked) {
      this.leaderboard.upsert({
        gameId,
        displayName: s.name,
        score: s.score,
        isWinner: s.isWinner === true,
      });
    }

    const duration = Math.max(1, Math.round((Date.now() - this.sessionStartedAt) / 1000));
    this.sessions.markCompleted(sessionId, duration);

    this.syncQueue.enqueue({
      tableName: 'arena_sessions',
      operation: 'UPDATE',
      payload: { id: sessionId, status: 'completed', duration_seconds: duration },
    });
    for (const s of ranked) {
      this.syncQueue.enqueue({
        tableName: 'arena_scores',
        operation: 'INSERT',
        payload: {
          session_id: sessionId,
          display_name: s.name,
          score: s.score,
          rank: s.rank,
          is_winner: s.isWinner === true,
        },
      });
    }

    const result: SessionResult = { sessionId, scores: ranked };
    this.currentSessionId = null;
    this.currentGameId = null;
    this.currentPlayers = [];
    this.engine.reset();
    return result;
  }
}
