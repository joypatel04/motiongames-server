import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDatabase, runMigrations } from '@/db/database.js';
import { SyncQueueRepository } from '@/db/repositories/sync-queue.repo.js';
import { ScoreSync } from '@/services/score-sync.js';

function makeQueue(): SyncQueueRepository {
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  return new SyncQueueRepository(db);
}

interface FakeBuilder {
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
}

function makeFakeSupabase(): { client: { from: ReturnType<typeof vi.fn> }; builders: Map<string, FakeBuilder> } {
  const builders = new Map<string, FakeBuilder>();
  const from = vi.fn((table: string) => {
    let b = builders.get(table);
    if (!b) {
      const eq = vi.fn().mockResolvedValue({ data: null, error: null });
      b = {
        upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
        update: vi.fn().mockReturnValue({ eq }),
        eq,
      };
      builders.set(table, b);
    }
    return b;
  });
  return { client: { from }, builders };
}

describe('ScoreSync', () => {
  let queue: SyncQueueRepository;

  beforeEach(() => {
    queue = makeQueue();
  });

  it('is a no-op when Supabase is not configured', async () => {
    queue.enqueue({
      tableName: 'arena_scores',
      operation: 'INSERT',
      payload: { session_id: 'a', display_name: 'p1', score: 10 },
    });
    const sync = new ScoreSync({ syncQueue: queue, supabaseClient: null });
    const flushed = await sync.flush();
    expect(flushed).toBe(0);
    expect(queue.pendingCount()).toBe(1);
  });

  it('returns zero when the queue is empty', async () => {
    const fake = makeFakeSupabase();
    const sync = new ScoreSync({
      syncQueue: queue,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });
    expect(await sync.flush()).toBe(0);
    expect(fake.client.from).not.toHaveBeenCalled();
  });

  it('upserts arena_scores INSERT rows and marks them synced', async () => {
    queue.enqueue({
      tableName: 'arena_scores',
      operation: 'INSERT',
      payload: { session_id: 's1', display_name: 'p1', score: 42, rank: 1, is_winner: true },
    });
    const fake = makeFakeSupabase();
    const sync = new ScoreSync({
      syncQueue: queue,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
      shopId: 'shop-abc',
    });

    const flushed = await sync.flush();
    expect(flushed).toBe(1);
    expect(queue.pendingCount()).toBe(0);

    const scoreBuilder = fake.builders.get('arena_scores_cloud');
    expect(scoreBuilder).toBeDefined();
    expect(scoreBuilder?.upsert).toHaveBeenCalledTimes(1);
    expect(scoreBuilder?.upsert.mock.calls[0]?.[0]).toMatchObject({
      session_id: 's1',
      display_name: 'p1',
      score: 42,
      arena_id: 'shop-abc',
    });
  });

  it('uses update().eq() for arena_sessions UPDATE rows', async () => {
    queue.enqueue({
      tableName: 'arena_sessions',
      operation: 'UPDATE',
      payload: { id: 'sess-1', status: 'completed', duration_seconds: 90 },
    });
    const fake = makeFakeSupabase();
    const sync = new ScoreSync({
      syncQueue: queue,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: fake.client as any,
    });

    const flushed = await sync.flush();
    expect(flushed).toBe(1);

    const sessionBuilder = fake.builders.get('arena_sessions_cloud');
    expect(sessionBuilder?.update).toHaveBeenCalledTimes(1);
    expect(sessionBuilder?.update.mock.calls[0]?.[0]).toMatchObject({
      status: 'completed',
      duration_seconds: 90,
    });
    expect(sessionBuilder?.eq).toHaveBeenCalledWith('id', 'sess-1');
  });

  it('keeps rows queued when Supabase returns an error', async () => {
    queue.enqueue({
      tableName: 'arena_scores',
      operation: 'INSERT',
      payload: { session_id: 's1', display_name: 'p1', score: 1 },
    });
    const failing = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ data: null, error: new Error('boom') }),
      }),
    };
    const sync = new ScoreSync({
      syncQueue: queue,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient: failing as any,
    });

    const flushed = await sync.flush();
    expect(flushed).toBe(0);
    expect(queue.pendingCount()).toBe(1);
  });
});
