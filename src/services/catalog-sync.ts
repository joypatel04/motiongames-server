import type { SupabaseClient } from '@supabase/supabase-js';
import type { GamesRepository } from '@/db/repositories/games.repo.js';
import { getSupabaseClient } from './supabase-client.js';
import { logger } from '@/utils/logger.js';

export interface CatalogSyncOptions {
  games: GamesRepository;
  intervalMs?: number;
  /** Override Supabase client resolution (used in tests). */
  supabaseClient?: SupabaseClient | null;
}

interface CloudArenaGameRow {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  min_players: number | null;
  max_players: number | null;
  difficulty_levels: unknown;
  definition: Record<string, unknown> | null;
  version: string | null;
  status: string;
}

/**
 * Periodically pulls published JSON game definitions from Supabase
 * `arena_games` into local SQLite so the engine can keep playing while
 * offline. A no-op when Supabase is not configured.
 */
export class CatalogSync {
  private readonly games: GamesRepository;
  private readonly intervalMs: number;
  private readonly clientOverride: SupabaseClient | null | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CatalogSyncOptions) {
    this.games = options.games;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.clientOverride = options.supabaseClient;
  }

  /** Run the first sync now, then keep syncing on a timer. */
  async start(): Promise<void> {
    await this.sync();
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sync().catch((err) => logger.error({ err }, 'catalog sync failed'));
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'catalog sync started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns the number of game rows upserted into local SQLite. */
  async sync(): Promise<number> {
    const supabase = this.resolveClient();
    if (!supabase) {
      logger.info('Supabase not configured — skipping catalog sync');
      return 0;
    }

    const { data, error } = await supabase
      .from('arena_games')
      .select('*')
      .in('status', ['ready', 'published']);

    if (error) {
      logger.error({ error }, 'failed to fetch games from Supabase');
      throw error;
    }

    const rows = (data ?? []) as CloudArenaGameRow[];
    if (rows.length === 0) {
      logger.info('no published games found in Supabase');
      return 0;
    }

    let upserted = 0;
    for (const row of rows) {
      try {
        const def = row.definition ?? {};
        const scoring = (def.scoring ?? {}) as { type?: string };
        const duration = (def.duration ?? {}) as { seconds?: number };
        this.games.upsertFromCloud({
          id: row.id,
          name: row.name,
          slug: row.slug,
          category: row.category ?? 'action',
          scoringType: scoring.type ?? 'points',
          minPlayers: row.min_players ?? 1,
          maxPlayers: row.max_players ?? 8,
          defaultDurationSeconds: duration.seconds ?? 60,
          difficultyLevels: JSON.stringify(
            Array.isArray(row.difficulty_levels)
              ? row.difficulty_levels
              : ['easy', 'medium', 'hard'],
          ),
          definition: JSON.stringify(row.definition ?? {}),
          version: row.version ?? '1.0.0',
          status: row.status,
        });
        upserted++;
      } catch (err) {
        logger.error({ err, slug: row.slug }, 'failed to upsert game from cloud');
      }
    }

    logger.info({ upserted, total: rows.length }, 'catalog sync complete');
    return upserted;
  }

  private resolveClient(): SupabaseClient | null {
    if (this.clientOverride !== undefined) return this.clientOverride;
    return getSupabaseClient();
  }
}
