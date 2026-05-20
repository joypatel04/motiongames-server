import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDatabase, runMigrations } from '@/db/database.js';
import { GamesRepository } from '@/db/repositories/games.repo.js';
import { CatalogSync } from '@/services/catalog-sync.js';

function makeRepo(): GamesRepository {
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  return new GamesRepository(db);
}

interface FakeSelect {
  in: ReturnType<typeof vi.fn>;
}

function makeSupabase(rows: unknown[] | null, error: Error | null = null): {
  client: { from: ReturnType<typeof vi.fn> };
} {
  const select: FakeSelect = {
    in: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  return {
    client: {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(select) }),
    },
  };
}

describe('CatalogSync', () => {
  let games: GamesRepository;

  beforeEach(() => {
    games = makeRepo();
  });

  it('is a no-op when Supabase is not configured', async () => {
    const sync = new CatalogSync({ games, supabaseClient: null });
    expect(await sync.sync()).toBe(0);
    expect(games.list()).toHaveLength(0);
  });

  it('returns 0 when Supabase has no published games', async () => {
    const fake = makeSupabase([]);
    const sync = new CatalogSync({
      games,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(await sync.sync()).toBe(0);
  });

  it('upserts published games and stores the definition JSON', async () => {
    const fake = makeSupabase([
      {
        id: 'cloud-id-1',
        name: 'Color Rush',
        slug: 'color-rush',
        category: 'action',
        min_players: 1,
        max_players: 4,
        difficulty_levels: ['easy', 'medium', 'hard'],
        definition: {
          description: 'A color matching game',
          duration: { seconds: 90 },
          scoring: { type: 'points' },
          players: { colors: ['#ff0000', '#00ff00'] },
        },
        version: '1.2.0',
        status: 'published',
      },
    ]);

    const sync = new CatalogSync({
      games,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(await sync.sync()).toBe(1);

    const row = games.getBySlug('color-rush');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Color Rush');
    expect(row?.version).toBe('1.2.0');
    expect(row?.status).toBe('published');
    expect(row?.default_duration_seconds).toBe(90);
    expect(row?.min_players).toBe(1);
    expect(row?.max_players).toBe(4);
    expect(row?.definition).toBeTruthy();
    const def = JSON.parse(row?.definition ?? '{}') as { description: string };
    expect(def.description).toBe('A color matching game');
  });

  it('re-upserts existing games on subsequent syncs (update path)', async () => {
    const fake = makeSupabase([
      {
        id: 'cloud-1',
        name: 'V1',
        slug: 'gx',
        category: 'action',
        min_players: 1,
        max_players: 2,
        difficulty_levels: ['easy'],
        definition: { duration: { seconds: 30 } },
        version: '1.0.0',
        status: 'ready',
      },
    ]);
    const sync = new CatalogSync({
      games,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    await sync.sync();
    expect(games.getBySlug('gx')?.name).toBe('V1');

    // Re-call with updated definition
    const updated = makeSupabase([
      {
        id: 'cloud-1',
        name: 'V2',
        slug: 'gx',
        category: 'action',
        min_players: 1,
        max_players: 4,
        difficulty_levels: ['easy', 'hard'],
        definition: { duration: { seconds: 60 } },
        version: '1.1.0',
        status: 'published',
      },
    ]);
    const sync2 = new CatalogSync({
      games,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: updated.client as any,
    });
    await sync2.sync();
    const row = games.getBySlug('gx');
    expect(row?.name).toBe('V2');
    expect(row?.version).toBe('1.1.0');
    expect(row?.default_duration_seconds).toBe(60);
    expect(row?.max_players).toBe(4);
  });

  it('propagates errors from Supabase select()', async () => {
    const fake = makeSupabase(null, new Error('rls denied'));
    const sync = new CatalogSync({
      games,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    await expect(sync.sync()).rejects.toThrow('rls denied');
  });
});
