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

    switch (row.table_name) {
      case 'arena_sessions': {
        // Map local arena_sessions → Supabase arena_play_sessions
        const sessionRow = {
          id: payload.id,
          game_id: payload.game_id,
          game_slug: payload.game_slug ?? null,
          game_version: payload.game_version ?? '1.0.0',
          difficulty: payload.difficulty ?? 'medium',
          player_count: payload.player_count ?? 1,
          grid_size: payload.grid_size ?? `${process.env.TILE_ROWS ?? 16}x${process.env.TILE_COLS ?? 12}`,
          duration_seconds: payload.duration_seconds ?? null,
          started_at: payload.start_time ?? payload.created_at,
          ended_at: payload.end_time ?? null,
          outcome: payload.status === 'completed' ? 'completed' : (payload.status as string) ?? null,
          stats: payload.metadata ?? null,
          revenue_amount: payload.total_price ?? null,
        };
        if (row.operation === 'INSERT') {
          const { error } = await supabase.from('arena_play_sessions').upsert(sessionRow);
          if (error) throw error;
        } else {
          const { id, ...updates } = sessionRow;
          const { error } = await supabase
            .from('arena_play_sessions')
            .update(updates)
            .eq('id', id as string);
          if (error) throw error;
        }
        break;
      }
      case 'arena_scores': {
        // Map local arena_scores → Supabase arena_session_players
        const playerRow = {
          id: payload.id,
          session_id: payload.session_id,
          player_number: payload.rank ?? 1,
          display_name: payload.display_name,
          player_profile_id: payload.player_profile_id ?? null,
          score: payload.score ?? 0,
          rank: payload.rank ?? null,
          is_winner: payload.is_winner === 1 || payload.is_winner === true,
          stats: payload.stats ?? null,
        };
        const { error } = await supabase.from('arena_session_players').upsert(playerRow);
        if (error) throw error;
        break;
      }
      default:
        logger.warn({ table: row.table_name }, 'unknown table in sync queue');
    }
  }
}
