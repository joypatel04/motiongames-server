import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadPartnerProfile,
  getDefaultPartnerProfile,
  resetPartnerProfile,
  getPartnerProfile,
} from '@/services/partner-config.js';

function makeSupabase(data: unknown, error: Error | null = null): {
  client: { from: ReturnType<typeof vi.fn> };
} {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  return { client: { from: vi.fn().mockReturnValue({ select }) } };
}

describe('partner-config', () => {
  beforeEach(() => {
    resetPartnerProfile();
    delete process.env.PARTNER_SLUG;
  });

  it('returns the Strikee Arena default when Supabase is not configured', async () => {
    const profile = await loadPartnerProfile({ supabaseClient: null });
    expect(profile.name).toBe('Strikee Arena');
    expect(profile.slug).toBe('default');
    expect(profile.primaryColor).toBe('#3b82f6');
  });

  it('falls back to default when no PARTNER_SLUG is provided', async () => {
    const fake = makeSupabase(null);
    const profile = await loadPartnerProfile({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(profile.name).toBe('Strikee Arena');
    expect(fake.client.from).not.toHaveBeenCalled();
  });

  it('falls back to default when the partner slug is not found', async () => {
    const fake = makeSupabase(null);
    const profile = await loadPartnerProfile({
      slug: 'missing',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(profile.name).toBe('Strikee Arena');
  });

  it('returns the cloud partner profile when the row exists', async () => {
    const fake = makeSupabase({
      id: 'p1',
      name: 'Demo Venue',
      slug: 'demo-venue',
      logo_url: 'https://example.com/logo.png',
      primary_color: '#10b981',
      secondary_color: '#047857',
      grid_rows: 16,
      grid_cols: 12,
      tile_count: 192,
      address: 'Navsari, Gujarat',
    });
    const profile = await loadPartnerProfile({
      slug: 'demo-venue',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(profile.id).toBe('p1');
    expect(profile.name).toBe('Demo Venue');
    expect(profile.primaryColor).toBe('#10b981');
    expect(profile.logoUrl).toBe('https://example.com/logo.png');
    expect(profile.address).toBe('Navsari, Gujarat');
  });

  it('caches the most recently loaded profile for getPartnerProfile', async () => {
    const fake = makeSupabase({
      id: 'p1',
      name: 'Demo Venue',
      slug: 'demo-venue',
      logo_url: null,
      primary_color: null,
      secondary_color: null,
      grid_rows: null,
      grid_cols: null,
      tile_count: null,
      address: null,
    });
    await loadPartnerProfile({
      slug: 'demo-venue',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(getPartnerProfile().name).toBe('Demo Venue');
    expect(getPartnerProfile().primaryColor).toBe('#3b82f6'); // applied default
  });

  it('falls back when Supabase select returns an error', async () => {
    const fake = makeSupabase(null, new Error('rls'));
    const profile = await loadPartnerProfile({
      slug: 'demo-venue',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(profile.name).toBe('Strikee Arena');
  });

  it('getDefaultPartnerProfile reads grid dimensions from env', () => {
    process.env.GRID_ROWS = '8';
    process.env.GRID_COLS = '6';
    const profile = getDefaultPartnerProfile();
    expect(profile.gridRows).toBe(8);
    expect(profile.gridCols).toBe(6);
    delete process.env.GRID_ROWS;
    delete process.env.GRID_COLS;
  });
});
