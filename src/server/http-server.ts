import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GamesRepository, GameRow } from '@/db/repositories/games.repo.js';
import type { SessionManager } from './session-manager.js';
import type { Difficulty } from '@/games/game.interface.js';
import { logger } from '@/utils/logger.js';

export interface HttpServerOptions {
  port: number;
  games: GamesRepository;
  sessionManager: SessionManager;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function loadSimulatorHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, 'static', 'simulator.html'), 'utf8');
}

/** Builds the public API representation of a game row (used by /api/games). */
export function gameRowToApi(g: GameRow): Record<string, unknown> {
  let description = '';
  let thumbnailUrl: string | null = null;
  let playerColors: string[] | null = null;
  if (g.definition) {
    try {
      const def = JSON.parse(g.definition) as Record<string, unknown>;
      if (typeof def.description === 'string') description = def.description;
      if (typeof def.thumbnailUrl === 'string') thumbnailUrl = def.thumbnailUrl;
      const players = def.players as { colors?: unknown } | undefined;
      if (players && Array.isArray(players.colors)) {
        playerColors = players.colors.filter((c): c is string => typeof c === 'string');
      }
    } catch {
      // Malformed definition — just skip the optional fields.
    }
  }
  let difficultyLevels: string[] = ['easy', 'medium', 'hard'];
  try {
    const parsed = JSON.parse(g.difficulty_levels ?? '[]') as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      difficultyLevels = parsed.filter((d): d is string => typeof d === 'string');
    }
  } catch {
    // fall back to default
  }
  return {
    slug: g.slug,
    name: g.name,
    category: g.category,
    minPlayers: g.min_players,
    maxPlayers: g.max_players,
    defaultDurationSeconds: g.default_duration_seconds,
    difficultyLevels,
    hasDefinition: Boolean(g.definition),
    version: g.version ?? '1.0.0',
    description,
    thumbnailUrl,
    playerColors,
  };
}

export class ArenaHttpServer {
  readonly server: Server;
  private readonly games: GamesRepository;
  private readonly sessionManager: SessionManager;
  private readonly simulatorHtml: string;
  private readonly port: number;

  constructor(options: HttpServerOptions) {
    this.port = options.port;
    this.games = options.games;
    this.sessionManager = options.sessionManager;
    this.simulatorHtml = loadSimulatorHtml();
    this.server = createServer((req, res) => this.handle(req, res));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', reject);
        logger.info({ port: this.port }, 'arena HTTP server listening');
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === 'GET' && (url === '/simulator' || url === '/simulator/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.simulatorHtml);
      return;
    }

    if (method === 'GET' && url === '/api/games') {
      const games = this.games.list().map(gameRowToApi);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ games }));
      return;
    }

    if (method === 'POST' && url === '/api/sessions') {
      this.handleCreateSession(req, res);
      return;
    }

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ error: 'Not found', url }));
  }

  private handleCreateSession(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as {
          gameSlug?: string;
          players?: unknown;
          difficulty?: Difficulty;
        };
        if (typeof parsed.gameSlug !== 'string' || !Array.isArray(parsed.players)) {
          throw new Error('gameSlug (string) and players (string[]) are required');
        }
        const players = parsed.players.filter((p): p is string => typeof p === 'string');
        const session = this.sessionManager.createSession({
          gameSlug: parsed.gameSlug,
          players,
          difficulty: parsed.difficulty ?? 'medium',
        });
        this.sessionManager.startGame();
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ sessionId: session.id, status: 'started' }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: message }));
      }
    });
  }
}
