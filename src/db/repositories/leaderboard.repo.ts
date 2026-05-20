import type { DB } from '@/db/database.js';
import { generateId, nowISO } from '@/db/database.js';

export interface LeaderboardRow {
  id: string;
  game_id: string;
  display_name: string;
  customer_id: string | null;
  player_profile_id: string | null;
  total_games: number;
  total_score: number;
  highest_score: number;
  average_score: number;
  wins: number;
  current_streak: number;
  best_streak: number;
  last_played_at: string | null;
}

export interface LeaderboardUpdate {
  gameId: string;
  displayName: string;
  score: number;
  isWinner: boolean;
  customerId?: string;
  playerProfileId?: string;
}

export class LeaderboardRepository {
  constructor(private readonly db: DB) {}

  upsert(update: LeaderboardUpdate): LeaderboardRow {
    const existing = this.db
      .prepare(
        'SELECT * FROM arena_leaderboard WHERE game_id = ? AND display_name = ?',
      )
      .get(update.gameId, update.displayName) as LeaderboardRow | undefined;

    if (!existing) {
      const id = generateId();
      this.db
        .prepare(
          `INSERT INTO arena_leaderboard
           (id, game_id, display_name, customer_id, player_profile_id,
            total_games, total_score, highest_score, average_score, wins,
            current_streak, best_streak, last_played_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          update.gameId,
          update.displayName,
          update.customerId ?? null,
          update.playerProfileId ?? null,
          update.score,
          update.score,
          update.score,
          update.isWinner ? 1 : 0,
          update.isWinner ? 1 : 0,
          update.isWinner ? 1 : 0,
          nowISO(),
        );
      return this.db.prepare('SELECT * FROM arena_leaderboard WHERE id = ?').get(id) as LeaderboardRow;
    }

    const totalGames = existing.total_games + 1;
    const totalScore = existing.total_score + update.score;
    const highest = Math.max(existing.highest_score, update.score);
    const avg = totalScore / totalGames;
    const wins = existing.wins + (update.isWinner ? 1 : 0);
    const currentStreak = update.isWinner ? existing.current_streak + 1 : 0;
    const bestStreak = Math.max(existing.best_streak, currentStreak);

    this.db
      .prepare(
        `UPDATE arena_leaderboard SET
           total_games = ?, total_score = ?, highest_score = ?, average_score = ?,
           wins = ?, current_streak = ?, best_streak = ?, last_played_at = ?
         WHERE id = ?`,
      )
      .run(totalGames, totalScore, highest, avg, wins, currentStreak, bestStreak, nowISO(), existing.id);
    return this.db.prepare('SELECT * FROM arena_leaderboard WHERE id = ?').get(existing.id) as LeaderboardRow;
  }

  top(gameId: string, limit = 10): LeaderboardRow[] {
    return this.db
      .prepare(
        'SELECT * FROM arena_leaderboard WHERE game_id = ? ORDER BY highest_score DESC, wins DESC LIMIT ?',
      )
      .all(gameId, limit) as LeaderboardRow[];
  }
}
