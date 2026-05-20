import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncQueueRepository, SyncRow } from '@/db/repositories/sync-queue.repo.js';
import { getSupabaseClient } from './supabase-client.js';
import { logger } from '@/utils/logger.js';

export interface ScoreSyncOptions {
  syncQueue: SyncQueueRepository;
  intervalMs?: number;
  batchSize?: number;
  shopId?: string;
  /** Override Supabase client resolution (used in tests). */
  supabaseClient?: SupabaseClient | null;
}

/**
 * Drains the local sync_queue and pushes completed session/score rows to
 * Supabase. Gracefully no-ops when Supabase is not configured so the engine
 * can keep running fully offline.
 */
export class ScoreSync {
  private readonly syncQueue: SyncQueueRepository;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly shopId: string;
  private readonly clientOverride: SupabaseClient | null | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScoreSyncOptions) {
    this.syncQueue = options.syncQueue;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.batchSize = options.batchSize ?? 50;
    this.shopId = options.shopId ?? '';
    this.clientOverride = options.supabaseClient;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => logger.error({ err }, 'score sync flush failed'));
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'score sync started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the number of rows successfully flushed. */
  async flush(): Promise<number> {
    const supabase = this.resolveClient();
    if (!supabase) return 0;

    const pending = this.syncQueue.dequeueUnsynced(this.batchSize);
    if (pending.length === 0) return 0;

    let synced = 0;
    for (const row of pending) {
      try {
        await this.syncRow(row, supabase);
        this.syncQueue.markSynced(row.id);
        synced++;
      } catch (err) {
        logger.error(
          { err, rowId: row.id, table: row.table_name },
          'failed to sync row, will retry next flush',
        );
      }
    }

    if (synced > 0) {
      logger.info({ synced, attempted: pending.length }, 'score sync flushed');
    }
    return synced;
  }

  private resolveClient(): SupabaseClient | null {
    if (this.clientOverride !== undefined) return this.clientOverride;
    return getSupabaseClient();
  }

  private async syncRow(row: SyncRow, supabase: SupabaseClient): Promise<void> {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const enriched = this.shopId ? { ...payload, arena_id: this.shopId } : payload;

    switch (row.table_name) {
      case 'arena_sessions': {
        if (row.operation === 'INSERT') {
          const { error } = await supabase.from('arena_sessions_cloud').upsert(enriched);
          if (error) throw error;
        } else {
          const { id, ...updates } = enriched as { id: unknown } & Record<string, unknown>;
          const { error } = await supabase
            .from('arena_sessions_cloud')
            .update(updates)
            .eq('id', id as string);
          if (error) throw error;
        }
        break;
      }
      case 'arena_scores': {
        const { error } = await supabase.from('arena_scores_cloud').upsert(enriched);
        if (error) throw error;
        break;
      }
      default:
        logger.warn({ table: row.table_name }, 'unknown table in sync queue');
    }
  }
}
