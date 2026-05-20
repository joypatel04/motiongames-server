import type { DB } from '@/db/database.js';
import { generateId, nowISO } from '@/db/database.js';

export type SessionStatus = 'pending' | 'active' | 'paused' | 'completed' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid' | 'on_credit' | 'cancelled';

export interface SessionRow {
  id: string;
  game_id: string;
  status: SessionStatus;
  player_count: number;
  difficulty: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  total_price: number | null;
  payment_status: PaymentStatus;
  metadata: string | null;
  created_at: string;
  synced: number;
}

export interface NewSession {
  gameId: string;
  playerCount: number;
  difficulty?: string;
  totalPrice?: number;
  metadata?: Record<string, unknown>;
}

export class SessionsRepository {
  constructor(private readonly db: DB) {}

  create(input: NewSession): SessionRow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO arena_sessions
         (id, game_id, status, player_count, difficulty, metadata, total_price)
         VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.gameId,
        input.playerCount,
        input.difficulty ?? 'medium',
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.totalPrice ?? null,
      );
    return this.getById(id) as SessionRow;
  }

  getById(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM arena_sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.prepare('UPDATE arena_sessions SET status = ? WHERE id = ?').run(status, id);
  }

  markStarted(id: string): void {
    this.db
      .prepare(`UPDATE arena_sessions SET status = 'active', start_time = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  markCompleted(id: string, durationSeconds: number): void {
    this.db
      .prepare(
        `UPDATE arena_sessions SET status = 'completed', end_time = ?, duration_seconds = ? WHERE id = ?`,
      )
      .run(nowISO(), durationSeconds, id);
  }

  setPaymentStatus(id: string, status: PaymentStatus): void {
    this.db.prepare('UPDATE arena_sessions SET payment_status = ? WHERE id = ?').run(status, id);
  }

  listRecent(limit = 20): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM arena_sessions ORDER BY created_at DESC LIMIT ?')
      .all(limit) as SessionRow[];
  }

  markSynced(id: string): void {
    this.db.prepare('UPDATE arena_sessions SET synced = 1 WHERE id = ?').run(id);
  }
}
