import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '@/config.js';
import { logger } from '@/utils/logger.js';

let cached: SupabaseClient | null | undefined;

/**
 * Returns a Supabase client when SUPABASE_URL and SUPABASE_ANON_KEY are
 * configured, otherwise null. The result is cached for the lifetime of the
 * process. Callers MUST handle the null case to allow offline operation.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;

  const url = config.supabaseUrl;
  // Prefer service-role for full catalog read access; fall back to anon for
  // limited reads (RLS on arena_games allows authenticated for ready/published).
  const key = process.env.SUPABASE_SERVICE_KEY ?? config.supabaseAnonKey;
  if (!url || !key) {
    logger.info('Supabase not configured — cloud sync disabled');
    cached = null;
    return cached;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  logger.info({ url }, 'Supabase client initialized');
  return cached;
}

/** Reset cache — exposed for tests. */
export function resetSupabaseClient(): void {
  cached = undefined;
}
