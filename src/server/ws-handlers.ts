import type { GamesRepository } from '@/db/repositories/games.repo.js';
import type { SessionsRepository } from '@/db/repositories/sessions.repo.js';
import type { LeaderboardRepository } from '@/db/repositories/leaderboard.repo.js';
import type { SessionManager } from '@/server/session-manager.js';
import type { GameEngine } from '@/engine/engine.js';
import type { ClientMessage, ServerMessage, GameSummary } from './ws-protocol.js';

export interface HandlerDeps {
  games: GamesRepository;
  sessions: SessionsRepository;
  leaderboard: LeaderboardRepository;
  sessionManager: SessionManager;
  engine: GameEngine;
}

export function handleMessage(deps: HandlerDeps, msg: ClientMessage): ServerMessage {
  switch (msg.type) {
    case 'list_games': {
      const rows = deps.games.list();
      const games: GameSummary[] = rows.map((g) => ({
        id: g.id,
        slug: g.slug,
        name: g.name,
        minPlayers: g.min_players,
        maxPlayers: g.max_players,
        defaultDurationSeconds: g.default_duration_seconds,
        category: g.category,
      }));
      return { type: 'games_list', games };
    }
    case 'create_session': {
      const session = deps.sessionManager.createSession({
        gameSlug: msg.gameSlug,
        players: msg.players,
        difficulty: msg.difficulty,
      });
      return { type: 'session_created', sessionId: session.id };
    }
    case 'start_game': {
      const sessionId = deps.sessionManager.getCurrentSessionId();
      if (!sessionId) return { type: 'error', message: 'No session loaded' };
      const game = deps.engine.getGame();
      deps.sessionManager.startGame();
      return { type: 'game_started', gameSlug: game?.id ?? 'unknown' };
    }
    case 'stop_game': {
      const result = deps.sessionManager.stopGame();
      if (!result) return { type: 'error', message: 'No active session' };
      return { type: 'game_ended', sessionId: result.sessionId, scores: result.scores };
    }
    case 'pause_game': {
      deps.sessionManager.pauseGame();
      return { type: 'game_paused' };
    }
    case 'resume_game': {
      deps.sessionManager.resumeGame();
      return { type: 'game_resumed' };
    }
    case 'get_status': {
      const timer = deps.engine.getTimer();
      return {
        type: 'status',
        engineState: deps.engine.getState(),
        sessionId: deps.sessionManager.getCurrentSessionId(),
        elapsedMs: timer ? timer.elapsedMs() : 0,
        remainingMs: timer ? timer.remainingMs() : 0,
      };
    }
    case 'get_leaderboard': {
      const game = deps.games.getBySlug(msg.gameSlug);
      if (!game) return { type: 'error', message: `Unknown game: ${msg.gameSlug}` };
      const entries = deps.leaderboard.top(game.id, msg.limit ?? 10).map((row) => ({
        displayName: row.display_name,
        highestScore: row.highest_score,
        totalGames: row.total_games,
        wins: row.wins,
        averageScore: row.average_score,
      }));
      return { type: 'leaderboard', gameSlug: msg.gameSlug, entries };
    }
    case 'get_history': {
      const rows = deps.sessions.listRecent(msg.limit ?? 20);
      return {
        type: 'history',
        sessions: rows.map((r) => ({
          id: r.id,
          gameId: r.game_id,
          status: r.status,
          playerCount: r.player_count,
          difficulty: r.difficulty,
          startTime: r.start_time,
          endTime: r.end_time,
          durationSeconds: r.duration_seconds,
        })),
      };
    }
    default: {
      const t = (msg as { type: string }).type;
      return { type: 'error', message: `Unknown message type: ${t}` };
    }
  }
}
