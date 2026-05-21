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

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  venue_avatar_url: string | null;
  venue_arenas: VenueArenaRow[];
}

interface VenueArenaRow {
  grid_rows: number | null;
  grid_cols: number | null;
  tile_count: number | null;
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
    name: 'Motion Games Arena',
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

  const venueId = options.slug ?? process.env.SHOP_ID;
  if (!venueId) {
    logger.info('SHOP_ID not set — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  const { data, error } = await supabase
    .from('venues')
    .select('id, name, address, venue_avatar_url, venue_arenas(grid_rows, grid_cols, tile_count)')
    .eq('id', venueId)
    .maybeSingle();

  if (error) {
    logger.warn({ venueId, error }, 'venue lookup failed — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  if (!data) {
    logger.warn({ venueId }, 'venue not found — using default partner profile');
    cachedProfile = getDefaultPartnerProfile();
    return cachedProfile;
  }

  const row = data as VenueRow;
  const arena = row.venue_arenas?.[0];
  cachedProfile = {
    id: row.id,
    name: row.name,
    slug: venueId,
    logoUrl: row.venue_avatar_url,
    primaryColor: '#3b82f6',
    secondaryColor: '#1e40af',
    gridRows: arena?.grid_rows ?? 16,
    gridCols: arena?.grid_cols ?? 12,
    tileCount: arena?.tile_count ?? 192,
    address: row.address,
  };
  logger.info({ partner: cachedProfile.name, venueId }, 'venue profile loaded');
  return cachedProfile;
}

export function getPartnerProfile(): PartnerProfile {
  return cachedProfile ?? getDefaultPartnerProfile();
}

/** Reset cached profile — exposed for tests. */
export function resetPartnerProfile(): void {
  cachedProfile = null;
}
