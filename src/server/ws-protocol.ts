import type { Difficulty, PlayerScore } from '@/games/game.interface.js';
import type { PartnerProfile } from '@/services/partner-config.js';

export interface GameSummary {
  id: string;
  slug: string;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  defaultDurationSeconds: number;
  category: string;
}

export interface LeaderboardEntry {
  displayName: string;
  highestScore: number;
  totalGames: number;
  wins: number;
  averageScore: number;
}

export interface SessionSummary {
  id: string;
  gameId: string;
  status: string;
  playerCount: number;
  difficulty: string | null;
  startTime: string | null;
  endTime: string | null;
  durationSeconds: number | null;
}

export interface TileColor {
  index: number;
  r: number;
  g: number;
  b: number;
}

export type ClientMessage =
  | { type: 'list_games' }
  | {
      type: 'create_session';
      gameSlug: string;
      players: string[];
      difficulty: Difficulty;
    }
  | { type: 'start_game' }
  | { type: 'stop_game' }
  | { type: 'pause_game' }
  | { type: 'resume_game' }
  | { type: 'get_status' }
  | { type: 'get_leaderboard'; gameSlug: string; limit?: number }
  | { type: 'get_history'; limit?: number }
  | { type: 'sensor'; tileIndex: number; pressed: boolean };

export type ServerMessage =
  | { type: 'games_list'; games: GameSummary[] }
  | { type: 'session_created'; sessionId: string }
  | { type: 'game_started'; gameSlug: string }
  | { type: 'game_paused' }
  | { type: 'game_resumed' }
  | { type: 'game_ended'; sessionId: string; scores: PlayerScore[] }
  | {
      type: 'status';
      engineState: string;
      sessionId: string | null;
      elapsedMs: number;
      remainingMs: number;
    }
  | {
      type: 'tile_update';
      tiles: TileColor[];
      elapsed: number;
      remaining: number;
    }
  | { type: 'leaderboard'; gameSlug: string; entries: LeaderboardEntry[] }
  | { type: 'history'; sessions: SessionSummary[] }
  | { type: 'error'; message: string }
  | { type: 'hello'; serverVersion: string }
  | {
      type: 'game_start';
      gameId: string;
      grid: { rows: number; cols: number };
      players: number;
    }
  | { type: 'game_end'; reason: string; scores: { name: string; score: number }[] }
  | { type: 'score_update'; playerIndex: number; score: number }
  | { type: 'partner_profile'; profile: PartnerProfile };

export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    throw new Error('Message missing "type"');
  }
  return parsed as ClientMessage;
}
