import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, runMigrations } from '@/db/database.js';
import { GamesRepository, DEFAULT_GAMES } from '@/db/repositories/games.repo.js';
import { ArenaHttpServer, gameRowToApi } from '@/server/http-server.js';
import type { SessionManager } from '@/server/session-manager.js';

function makeRepo(): GamesRepository {
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  const repo = new GamesRepository(db);
  repo.seedDefaults(DEFAULT_GAMES);
  return repo;
}

function fakeSessionManager(): {
  createSession: ReturnType<typeof vi.fn>;
  startGame: ReturnType<typeof vi.fn>;
  manager: SessionManager;
} {
  const createSession = vi.fn().mockReturnValue({ id: 'session-1' });
  const startGame = vi.fn();
  const manager = { createSession, startGame } as unknown as SessionManager;
  return { createSession, startGame, manager };
}

describe('ArenaHttpServer', () => {
  let server: ArenaHttpServer;
  let port: number;
  let games: GamesRepository;
  let sm: ReturnType<typeof fakeSessionManager>;

  beforeEach(async () => {
    games = makeRepo();
    sm = fakeSessionManager();
    server = new ArenaHttpServer({ port: 0, games, sessionManager: sm.manager });
    await server.listen();
    const addr = server.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves /simulator with HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/simulator`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Arena Floor Simulator');
  });

  it('returns the catalog at GET /api/games with CORS', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/games`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { games: { slug: string }[] };
    const slugs = body.games.map((g) => g.slug).sort();
    expect(slugs).toEqual(['lava-run', 'race-to-light', 'whack-a-mole']);
  });

  it('answers OPTIONS preflight with 204 and CORS headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('creates a session via POST /api/sessions', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameSlug: 'whack-a-mole',
        players: ['Alice', 'Bob'],
        difficulty: 'easy',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; status: string };
    expect(body.sessionId).toBe('session-1');
    expect(body.status).toBe('started');
    expect(sm.createSession).toHaveBeenCalledWith({
      gameSlug: 'whack-a-mole',
      players: ['Alice', 'Bob'],
      difficulty: 'easy',
    });
    expect(sm.startGame).toHaveBeenCalled();
  });

  it('returns 400 on malformed POST /api/sessions body', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameSlug: 'whack-a-mole' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown routes with CORS', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('gameRowToApi', () => {
  it('parses description and player colors from definition JSON', () => {
    const api = gameRowToApi({
      id: 'g1',
      name: 'X',
      slug: 'x',
      category: 'action',
      scoring_type: 'points',
      min_players: 1,
      max_players: 4,
      default_duration_seconds: 60,
      difficulty_levels: '["easy"]',
      is_active: 1,
      is_premium: 0,
      created_at: 'now',
      definition: JSON.stringify({
        description: 'hello',
        thumbnailUrl: 'https://example.com/x.png',
        players: { colors: ['#ff0000', '#00ff00'] },
      }),
      version: '1.0.0',
      status: 'ready',
    });
    expect(api.description).toBe('hello');
    expect(api.thumbnailUrl).toBe('https://example.com/x.png');
    expect(api.playerColors).toEqual(['#ff0000', '#00ff00']);
    expect(api.hasDefinition).toBe(true);
  });

  it('uses defaults when there is no definition', () => {
    const api = gameRowToApi({
      id: 'g2',
      name: 'Y',
      slug: 'y',
      category: 'action',
      scoring_type: 'points',
      min_players: 1,
      max_players: 4,
      default_duration_seconds: 60,
      difficulty_levels: '[]',
      is_active: 1,
      is_premium: 0,
      created_at: 'now',
      definition: null,
      version: null,
      status: null,
    });
    expect(api.hasDefinition).toBe(false);
    expect(api.description).toBe('');
    expect(api.playerColors).toBeNull();
    expect(api.version).toBe('1.0.0');
  });
});
