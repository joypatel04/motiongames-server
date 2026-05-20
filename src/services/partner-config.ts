import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabase-client.js';
import { logger } from '@/utils/logger.js';

export interface PartnerProfile {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  gridRows: number;
  gridCols: number;
  tileCount: number;
  address: string | null;
}

interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  grid_rows: number | null;
  grid_cols: number | null;
  tile_count: number | null;
  address: string | null;
}

export interface LoadPartnerProfileOptions {
  /** Override Supabase client resolution (used in tests). */
  supabaseClient?: SupabaseClient | null;
  /** Override the PARTNER_SLUG env var. */
  slug?: string;
}

let cachedProfile: PartnerProfile | null = null;

export function getDefaultPartnerProfile(): PartnerProfile {
  return {
    id: 'default',
    name: 'Strikee Arena',
    slug: 'default',
    logoUrl: null,
    primaryColor: '#3b82f6',
    secondaryColor: '#1e40af',
    gridRows: Number(process.env.GRID_ROWS ?? process.env.TILE_ROWS ?? 16),
    gridCols: Number(process.env.GRID_COLS ?? process.env.TILE_COLS ?? 12),
    tileCount: Number(process.env.TILE_COUNT ?? 192),
    address: null,
  };
}

/**
 * Load the partner profile for this arena installation. Falls back to a
 * 'Strikee Arena' default when Supabase is not configured, the slug is
 * missing, or the row is not found — the server keeps working with sane
 * branding either way.
 */
export async function loadPartnerProfile(
  options: LoadPartnerProfileOptions = {},
): Promise<PartnerProfile> {
  const supabase = options.supabaseClient !== undefined ? options.supabaseClient : getSupabaseClient();
  if (!supabase) {
    logger.info('Supabase not configured — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  const slug = options.slug ?? process.env.PARTNER_SLUG;
  if (!slug) {
    logger.info('PARTNER_SLUG not set — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  const { data, error } = await supabase
    .from('arena_partners')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    logger.warn({ slug, error }, 'partner lookup failed — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  if (!data) {
    logger.warn({ slug }, 'partner not found — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  const row = data as PartnerRow;
  cachedProfile = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    primaryColor: row.primary_color ?? '#3b82f6',
    secondaryColor: row.secondary_color ?? '#1e40af',
    gridRows: row.grid_rows ?? 16,
    gridCols: row.grid_cols ?? 12,
    tileCount: row.tile_count ?? 192,
    address: row.address,
  };
  logger.info({ partner: cachedProfile.name, slug: cachedProfile.slug }, 'partner profile loaded');
  return cachedProfile;
}

export function getPartnerProfile(): PartnerProfile {
  return cachedProfile ?? getDefaultPartnerProfile();
}

/** Reset cached profile — exposed for tests. */
export function resetPartnerProfile(): void {
  cachedProfile = null;
}
