import type { DB } from '@/db/database.js';
import { generateId } from '@/db/database.js';

export interface ScoreRow {
  id: string;
  session_id: string;
  display_name: string;
  customer_id: string | null;
  player_profile_id: string | null;
  score: number;
  rank: number | null;
  is_winner: number;
  stats: string | null;
  created_at: string;
  synced: number;
}

export interface NewScore {
  sessionId: string;
  displayName: string;
  score: number;
  rank?: number;
  isWinner?: boolean;
  customerId?: string;
  playerProfileId?: string;
  stats?: Record<string, number | string>;
}

export class ScoresRepository {
  constructor(private readonly db: DB) {}

  insertBatch(scores: NewScore[]): ScoreRow[] {
    const insert = this.db.prepare(
      `INSERT INTO arena_scores
       (id, session_id, display_name, customer_id, player_profile_id, score, rank, is_winner, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const select = this.db.prepare('SELECT * FROM arena_scores WHERE id = ?');
    const out: ScoreRow[] = [];
    const tx = this.db.transaction((rows: NewScore[]) => {
      for (const s of rows) {
        const id = generateId();
        insert.run(
          id,
          s.sessionId,
          s.displayName,
          s.customerId ?? null,
          s.playerProfileId ?? null,
          s.score,
          s.rank ?? null,
          s.isWinner ? 1 : 0,
          s.stats ? JSON.stringify(s.stats) : null,
        );
        out.push(select.get(id) as ScoreRow);
      }
    });
    tx(scores);
    return out;
  }

  listBySession(sessionId: string): ScoreRow[] {
    return this.db
      .prepare(
        'SELECT * FROM arena_scores WHERE session_id = ? ORDER BY rank ASC, score DESC',
      )
      .all(sessionId) as ScoreRow[];
  }

  markSynced(id: string): void {
    this.db.prepare('UPDATE arena_scores SET synced = 1 WHERE id = ?').run(id);
  }
}
