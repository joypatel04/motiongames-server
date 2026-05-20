import type { DB } from '@/db/database.js';
import { nowISO } from '@/db/database.js';

export interface SyncRow {
  id: number;
  table_name: string;
  operation: 'INSERT' | 'UPDATE';
  payload: string;
  synced: number;
  created_at: string;
  synced_at: string | null;
}

export interface SyncEnqueueInput {
  tableName: string;
  operation: 'INSERT' | 'UPDATE';
  payload: Record<string, unknown>;
}

export class SyncQueueRepository {
  constructor(private readonly db: DB) {}

  enqueue(input: SyncEnqueueInput): number {
    const result = this.db
      .prepare('INSERT INTO sync_queue (table_name, operation, payload) VALUES (?, ?, ?)')
      .run(input.tableName, input.operation, JSON.stringify(input.payload));
    return Number(result.lastInsertRowid);
  }

  dequeueUnsynced(limit = 50): SyncRow[] {
    return this.db
      .prepare('SELECT * FROM sync_queue WHERE synced = 0 ORDER BY id ASC LIMIT ?')
      .all(limit) as SyncRow[];
  }

  markSynced(id: number): void {
    this.db.prepare('UPDATE sync_queue SET synced = 1, synced_at = ? WHERE id = ?').run(nowISO(), id);
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM sync_queue WHERE synced = 0').get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }
}
