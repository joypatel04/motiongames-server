import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, runMigrations, type DB } from '@/db/database.js';
import { GamesRepository, DEFAULT_GAMES } from '@/db/repositories/games.repo.js';
import { SessionsRepository } from '@/db/repositories/sessions.repo.js';
import { ScoresRepository } from '@/db/repositories/scores.repo.js';
import { LeaderboardRepository } from '@/db/repositories/leaderboard.repo.js';
import { SyncQueueRepository } from '@/db/repositories/sync-queue.repo.js';

let db: DB;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  runMigrations(db);
});

describe('GamesRepository', () => {
  it('seeds defaults idempotently', () => {
    const repo = new GamesRepository(db);
    repo.seedDefaults(DEFAULT_GAMES);
    repo.seedDefaults(DEFAULT_GAMES); // second time no-op
    const games = repo.list();
    expect(games).toHaveLength(DEFAULT_GAMES.length);
    const slugs = games.map((g) => g.slug).sort();
    expect(slugs).toContain('whack-a-mole');
    expect(slugs).toContain('lava-run');
    expect(slugs).toContain('race-to-light');
  });

  it('getBySlug returns the row', () => {
    const repo = new GamesRepository(db);
    repo.seedDefaults(DEFAULT_GAMES);
    const w = repo.getBySlug('whack-a-mole');
    expect(w).toBeDefined();
    expect(w?.min_players).toBe(1);
  });
});

describe('SessionsRepository', () => {
  it('creates a session and updates its lifecycle', () => {
    const games = new GamesRepository(db);
    games.seedDefaults(DEFAULT_GAMES);
    const game = games.getBySlug('whack-a-mole')!;
    const sessions = new SessionsRepository(db);

    const s = sessions.create({ gameId: game.id, playerCount: 2, difficulty: 'easy' });
    expect(s.status).toBe('pending');
    sessions.markStarted(s.id);
    expect(sessions.getById(s.id)?.status).toBe('active');
    sessions.markCompleted(s.id, 30);
    const completed = sessions.getById(s.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.duration_seconds).toBe(30);
  });

  it('listRecent returns most recent sessions first', () => {
    const games = new GamesRepository(db);
    games.seedDefaults(DEFAULT_GAMES);
    const gid = games.getBySlug('whack-a-mole')!.id;
    const sessions = new SessionsRepository(db);
    const a = sessions.create({ gameId: gid, playerCount: 1 });
    const b = sessions.create({ gameId: gid, playerCount: 1 });
    const list = sessions.listRecent(2);
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toContain(a.id);
    expect(list.map((s) => s.id)).toContain(b.id);
  });
});

describe('ScoresRepository', () => {
  it('inserts a batch of scores and reads them back', () => {
    const games = new GamesRepository(db);
    games.seedDefaults(DEFAULT_GAMES);
    const gid = games.getBySlug('lava-run')!.id;
    const sessions = new SessionsRepository(db);
    const session = sessions.create({ gameId: gid, playerCount: 2 });
    const scores = new ScoresRepository(db);
    scores.insertBatch([
      { sessionId: session.id, displayName: 'A', score: 50, isWinner: true, rank: 1 },
      { sessionId: session.id, displayName: 'B', score: 30, rank: 2 },
    ]);
    const rows = scores.listBySession(session.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.display_name).toBe('A');
    expect(rows[0]!.is_winner).toBe(1);
  });
});

describe('LeaderboardRepository', () => {
  it('upserts and aggregates over multiple games', () => {
    const games = new GamesRepository(db);
    games.seedDefaults(DEFAULT_GAMES);
    const gid = games.getBySlug('race-to-light')!.id;
    const lb = new LeaderboardRepository(db);
    lb.upsert({ gameId: gid, displayName: 'Alex', score: 100, isWinner: true });
    lb.upsert({ gameId: gid, displayName: 'Alex', score: 80, isWinner: false });
    lb.upsert({ gameId: gid, displayName: 'Sam', score: 150, isWinner: true });
    const top = lb.top(gid, 5);
    expect(top[0]!.display_name).toBe('Sam');
    const alex = top.find((r) => r.display_name === 'Alex')!;
    expect(alex.total_games).toBe(2);
    expect(alex.highest_score).toBe(100);
    expect(alex.current_streak).toBe(0);
  });
});

describe('SyncQueueRepository', () => {
  it('enqueues and dequeues unsynced rows', () => {
    const q = new SyncQueueRepository(db);
    const id1 = q.enqueue({ tableName: 'arena_sessions', operation: 'INSERT', payload: { a: 1 } });
    q.enqueue({ tableName: 'arena_scores', operation: 'INSERT', payload: { b: 2 } });
    expect(q.pendingCount()).toBe(2);
    const pending = q.dequeueUnsynced(10);
    expect(pending).toHaveLength(2);
    q.markSynced(id1);
    expect(q.pendingCount()).toBe(1);
  });
});
