import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { ArenaWsServer } from '@/server/ws-server.js';
import { openDatabase, runMigrations, type DB } from '@/db/database.js';
import { GamesRepository, DEFAULT_GAMES } from '@/db/repositories/games.repo.js';
import { SessionsRepository } from '@/db/repositories/sessions.repo.js';
import { ScoresRepository } from '@/db/repositories/scores.repo.js';
import { LeaderboardRepository } from '@/db/repositories/leaderboard.repo.js';
import { SyncQueueRepository } from '@/db/repositories/sync-queue.repo.js';
import { MockDriver } from '@/drivers/mock.driver.js';
import { Grid } from '@/engine/grid.js';
import { GameEngine } from '@/engine/engine.js';
import { SessionManager } from '@/server/session-manager.js';
import type { ServerMessage } from '@/server/ws-protocol.js';

let server: ArenaWsServer;
let db: DB;
let port: number;

function send(ws: WebSocket, obj: unknown): void {
  ws.send(JSON.stringify(obj));
}

class MsgQueue {
  private queue: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];

  push(m: ServerMessage): void {
    const w = this.waiters.shift();
    if (w) w(m);
    else this.queue.push(m);
  }

  next(timeoutMs = 3000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }
}

async function connect(): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const q = new MsgQueue();
  ws.on('message', (data) => {
    try {
      q.push(JSON.parse(data.toString()) as ServerMessage);
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  // consume hello
  await q.next();
  return { ws, q };
}

beforeAll(async () => {
  db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  const games = new GamesRepository(db);
  games.seedDefaults(DEFAULT_GAMES);
  const sessions = new SessionsRepository(db);
  const scores = new ScoresRepository(db);
  const leaderboard = new LeaderboardRepository(db);
  const syncQueue = new SyncQueueRepository(db);
  const driver = new MockDriver({ tileCount: 16 });
  await driver.connect();
  const grid = new Grid({ rows: 4, cols: 4 });
  const engine = new GameEngine({ driver, grid, autoTick: false });
  const sessionManager = new SessionManager({
    engine,
    games,
    sessions,
    scores,
    leaderboard,
    syncQueue,
  });

  // Pick a free port
  port = 38000 + Math.floor(Math.random() * 1000);
  server = new ArenaWsServer({
    port,
    deps: { games, sessions, leaderboard, sessionManager, engine },
  });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

describe('ArenaWsServer', () => {
  it('responds to list_games', async () => {
    const { ws, q } = await connect();
    send(ws, { type: 'list_games' });
    const reply = await q.next();
    expect(reply.type).toBe('games_list');
    if (reply.type === 'games_list') {
      expect(reply.games.length).toBeGreaterThan(0);
    }
    ws.close();
  });

  it('responds with error for unknown game in create_session', async () => {
    const { ws, q } = await connect();
    send(ws, {
      type: 'create_session',
      gameSlug: 'no-such-game',
      players: ['a'],
      difficulty: 'easy',
    });
    const reply = await q.next();
    expect(reply.type).toBe('error');
    ws.close();
  });

  it('handles invalid JSON as error', async () => {
    const { ws, q } = await connect();
    ws.send('{not-json');
    const reply = await q.next();
    expect(reply.type).toBe('error');
    ws.close();
  });

  it('returns history (empty allowed)', async () => {
    const { ws, q } = await connect();
    send(ws, { type: 'get_history', limit: 5 });
    const reply = await q.next();
    expect(reply.type).toBe('history');
    ws.close();
  });

  it('returns leaderboard for known game', async () => {
    const { ws, q } = await connect();
    send(ws, { type: 'get_leaderboard', gameSlug: 'whack-a-mole' });
    const reply = await q.next();
    expect(reply.type).toBe('leaderboard');
    ws.close();
  });
});
