# Ralph Loop — Live Pipeline (Catalog Sync + WebSocket Streaming + Floor Simulator)

> **Linear:** STR-11 + STR-12 + STR-13 | **Repo:** arena-server | **Day 5–6**
> **When done, update Linear:** mark STR-11, STR-12, and STR-13 as Done
> **Blocked by:** STR-5 (Supabase schema — DONE), STR-9 (JsonGameAdapter),
>   STR-10 (Factory update)

## Goal

Close the loop from Supabase → server → visual output:

1. **Catalog sync** — Server fetches published game definitions from Supabase
   `arena_games` table on startup and periodically, storing them in local
   SQLite for offline play.
2. **WebSocket tile streaming** — Real-time tile color data streamed to
   connected clients (the floor simulator and future launcher).
3. **Floor simulator** — An HTML page served by the server that renders a
   virtual LED grid in the browser, receiving tile updates over WebSocket.

**After this, you can publish a game in the designer, and within seconds see it
playing in a browser-based floor simulator.**

## Important context

- Read `CLAUDE.md` for project conventions.
- The Supabase project ID is `agqnqwispnaytefftgpe`.
- Use the **anon key** for reads from Supabase (the `arena_games` table has
  RLS policy allowing `SELECT` for `authenticated` where `status IN
  ('ready', 'published')`). For the sync service, use the **service_role key**
  so it can read all games regardless of status, OR use authenticated with a
  service account.
- The server already has `@supabase/supabase-js` in dependencies (see
  package.json).
- WebSocket server (`ws` package) is already a dependency.
- The existing engine tick loop is in `src/engine/engine.ts` — it calls
  `game.tick(delta)` and then `driver.setBatchTiles(result.tileUpdates)`.

## Task 1: Supabase catalog sync service (STR-11)

### Create `src/services/supabase-client.ts`

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY; // service_role for full access

  if (!url || !key) {
    console.warn('Supabase not configured — catalog sync disabled');
    return null;
  }

  client = createClient(url, key);
  return client;
}
```

### Create `src/services/catalog-sync.ts`

This service:
- Fetches all `ready` + `published` games from Supabase `arena_games`
- Upserts them into local SQLite `arena_games` (with the `definition` column
  added in the migration from RALPH_JSON_ADAPTER)
- Runs on startup and then every 60 seconds (configurable)

```typescript
import { getSupabaseClient } from './supabase-client.js';
import type { GamesRepository } from '@/db/repositories/games.repo.js';
import pino from 'pino';

const logger = pino({ name: 'catalog-sync' });

export interface CatalogSyncOptions {
  games: GamesRepository;
  intervalMs?: number; // default 60_000
}

export class CatalogSync {
  private readonly games: GamesRepository;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CatalogSyncOptions) {
    this.games = options.games;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  async start(): Promise<void> {
    // Initial sync
    await this.sync();

    // Periodic sync
    this.timer = setInterval(() => {
      this.sync().catch((err) => logger.error({ err }, 'Catalog sync failed'));
    }, this.intervalMs);

    logger.info({ intervalMs: this.intervalMs }, 'Catalog sync started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sync(): Promise<number> {
    const supabase = getSupabaseClient();
    if (!supabase) {
      logger.warn('Supabase not configured, skipping sync');
      return 0;
    }

    const { data, error } = await supabase
      .from('arena_games')
      .select('*')
      .in('status', ['ready', 'published']);

    if (error) {
      logger.error({ error }, 'Failed to fetch games from Supabase');
      throw error;
    }

    if (!data || data.length === 0) {
      logger.info('No games found in Supabase');
      return 0;
    }

    let upserted = 0;
    for (const row of data) {
      try {
        this.games.upsertFromCloud({
          id: row.id,
          name: row.name,
          slug: row.slug,
          category: row.category ?? 'action',
          scoringType: row.definition?.scoring?.type ?? 'points',
          minPlayers: row.min_players ?? 1,
          maxPlayers: row.max_players ?? 8,
          defaultDurationSeconds: row.definition?.duration?.seconds ?? 60,
          difficultyLevels: JSON.stringify(row.difficulty_levels ?? ['easy', 'medium', 'hard']),
          definition: JSON.stringify(row.definition),
          version: row.version ?? '1.0.0',
          status: row.status,
        });
        upserted++;
      } catch (err) {
        logger.error({ err, slug: row.slug }, 'Failed to upsert game');
      }
    }

    logger.info({ upserted, total: data.length }, 'Catalog sync complete');
    return upserted;
  }
}
```

### Add `upsertFromCloud` method to GamesRepository

In `src/db/repositories/games.repo.ts`, add:

```typescript
interface CloudGameInput {
  id: string;
  name: string;
  slug: string;
  category: string;
  scoringType: string;
  minPlayers: number;
  maxPlayers: number;
  defaultDurationSeconds: number;
  difficultyLevels: string;
  definition: string;  // JSON string
  version: string;
  status: string;
}

upsertFromCloud(input: CloudGameInput): void {
  this.db.prepare(`
    INSERT INTO arena_games (id, name, slug, category, scoring_type,
      min_players, max_players, default_duration_seconds,
      difficulty_levels, definition, version, status, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      scoring_type = excluded.scoring_type,
      min_players = excluded.min_players,
      max_players = excluded.max_players,
      default_duration_seconds = excluded.default_duration_seconds,
      difficulty_levels = excluded.difficulty_levels,
      definition = excluded.definition,
      version = excluded.version,
      status = excluded.status
  `).run(
    input.id, input.name, input.slug, input.category, input.scoringType,
    input.minPlayers, input.maxPlayers, input.defaultDurationSeconds,
    input.difficultyLevels, input.definition, input.version, input.status
  );
}
```

### Add env vars

**⚠️ DO NOT set Supabase keys in `.env.local` during development.** We share a
single Supabase project with no staging environment. When keys are missing,
`CatalogSync` should log a warning and skip — the server still works, it just
uses whatever games are already seeded in local SQLite.

Update `.env.example` (documentation only):
```
# Only set these in production / on the actual arena hardware
SUPABASE_URL=https://agqnqwispnaytefftgpe.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
CATALOG_SYNC_INTERVAL_MS=60000
```

### Dev workflow without Supabase

For local development, games get into SQLite via one of:
1. The `seedDefaults()` method in GamesRepository (existing 3 hard-coded games)
2. A new `seedFromFile(path)` method that reads a GameDefinition JSON file
   from disk and inserts it into the local arena_games table

Add this seed method so developers can test JSON games locally:

```typescript
// In games.repo.ts
seedFromJsonFile(filePath: string): void {
  const raw = readFileSync(filePath, 'utf-8');
  const def = JSON.parse(raw);
  this.upsertFromCloud({
    id: def.id ?? randomUUID(),
    name: def.name,
    slug: def.id.replace(/^preset_/, '').replace(/_/g, '-'),
    category: def.category ?? 'action',
    scoringType: def.scoring?.type ?? 'points',
    minPlayers: def.players?.min ?? 1,
    maxPlayers: def.players?.max ?? 8,
    defaultDurationSeconds: def.duration?.seconds ?? 60,
    difficultyLevels: JSON.stringify(Object.keys(def.difficultyPresets ?? def.difficulties ?? {})),
    definition: raw,
    version: def.version ?? '1.0.0',
    status: 'ready',
  });
}
```

Then in the server bootstrap, seed JSON games from a local directory:

```typescript
// Seed JSON games from local presets (dev mode, no Supabase needed)
const presetsDir = path.join(__dirname, '../presets');
if (existsSync(presetsDir)) {
  for (const file of readdirSync(presetsDir).filter(f => f.endsWith('.json'))) {
    gamesRepo.seedFromJsonFile(path.join(presetsDir, file));
    logger.info({ file }, 'Seeded game from local preset');
  }
}
```

Create a `presets/` directory in arena-server root and copy game JSON files
there for local testing.

## Task 1b: REST API for game catalog

The launcher (and simulator) need to fetch the list of available games. Add a
simple REST endpoint to the server's HTTP handler.

### `GET /api/games`

Returns all active games from SQLite (both code games and JSON games).

```typescript
// In the HTTP request handler:
if (req.url === '/api/games' && req.method === 'GET') {
  const games = gamesRepo.list().map((g) => ({
    slug: g.slug,
    name: g.name,
    category: g.category,
    minPlayers: g.min_players,
    maxPlayers: g.max_players,
    defaultDurationSeconds: g.default_duration_seconds,
    difficultyLevels: JSON.parse(g.difficulty_levels ?? '["easy","medium","hard"]'),
    hasDefinition: !!g.definition,  // true = JSON game, false = code game
    version: g.version ?? '1.0.0',
    // Extract description and thumbnail from definition if available
    description: g.definition ? JSON.parse(g.definition).description : '',
    thumbnailUrl: g.definition ? JSON.parse(g.definition).thumbnailUrl : null,
    playerColors: g.definition ? JSON.parse(g.definition).players?.colors : null,
  }));

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',  // needed for launcher on different port
  });
  res.end(JSON.stringify({ games }));
  return;
}

// CORS preflight for the launcher
if (req.method === 'OPTIONS') {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
  return;
}
```

### `POST /api/sessions`

Start a new game session (alternative to the WebSocket `start_session` message).
Useful for the launcher and testing.

```typescript
if (req.url === '/api/sessions' && req.method === 'POST') {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const { gameSlug, players, difficulty } = JSON.parse(body);
      const session = sessionManager.createSession({
        gameSlug,
        players,
        difficulty: difficulty ?? 'medium',
      });
      sessionManager.startGame();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ sessionId: session.id, status: 'started' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  return;
}
```

This means the launcher can start a game with a simple `fetch('/api/sessions', { method: 'POST', body: ... })` — no need to also implement `start_session` over WebSocket initially.

## Task 2: WebSocket tile streaming protocol (STR-12)

### Create `src/server/ws-server.ts`

The WebSocket server streams tile updates in real time to all connected clients.

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { GameEngine } from '@/engine/engine.js';
import pino from 'pino';

const logger = pino({ name: 'ws-server' });

export interface WsServerOptions {
  server: Server;
  engine: GameEngine;
  path?: string; // default '/ws'
}

/** Message types sent to clients */
interface TileUpdateMessage {
  type: 'tile_update';
  tiles: Array<{ i: number; r: number; g: number; b: number }>;
  elapsed: number;
  remaining: number;
}

interface GameStartMessage {
  type: 'game_start';
  gameId: string;
  grid: { rows: number; cols: number };
  players: number;
}

interface GameEndMessage {
  type: 'game_end';
  reason: string;
  scores: Array<{ name: string; score: number }>;
}

interface ScoreUpdateMessage {
  type: 'score_update';
  playerIndex: number;
  score: number;
}

type ServerMessage = TileUpdateMessage | GameStartMessage | GameEndMessage | ScoreUpdateMessage;

/** Message types received from clients */
interface SensorMessage {
  type: 'sensor';
  tileIndex: number;
  pressed: boolean;
}

type ClientMessage = SensorMessage;

export class WsGameServer {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private engine: GameEngine;

  constructor(options: WsServerOptions) {
    this.engine = options.engine;
    this.wss = new WebSocketServer({
      server: options.server,
      path: options.path ?? '/ws',
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info({ clients: this.clients.size }, 'Client connected');

      ws.on('message', (raw) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          this.handleClientMessage(msg);
        } catch {
          logger.warn('Invalid message from client');
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info({ clients: this.clients.size }, 'Client disconnected');
      });
    });

    // Hook into engine events
    this.engine.emitter.on('game_start', (data) => {
      this.broadcast({
        type: 'game_start',
        gameId: data.gameId,
        grid: { rows: this.engine.grid.rows, cols: this.engine.grid.cols },
        players: data.players,
      });
    });

    this.engine.emitter.on('game_end', (data) => {
      const scores = this.engine.getScores();
      this.broadcast({
        type: 'game_end',
        reason: data.reason,
        scores: scores.map((s) => ({ name: s.name, score: s.score })),
      });
    });

    this.engine.emitter.on('tick', (data) => {
      // Tile updates come from the driver's setBatchTiles — we intercept via
      // a custom event or by wrapping the driver. For now, we emit tile data
      // alongside the tick event. See driver wrapper below.
    });

    this.engine.emitter.on('score_update', (data) => {
      this.broadcast({
        type: 'score_update',
        playerIndex: data.playerIndex,
        score: data.score ?? data.total ?? 0,
      });
    });
  }

  /** Send tile update frame to all clients */
  sendTileUpdate(tiles: Array<{ i: number; r: number; g: number; b: number }>, elapsed: number, remaining: number): void {
    if (this.clients.size === 0) return;
    this.broadcast({
      type: 'tile_update',
      tiles,
      elapsed,
      remaining,
    });
  }

  private handleClientMessage(msg: ClientMessage): void {
    if (msg.type === 'sensor') {
      // Simulate sensor input from the floor simulator
      this.engine.emitter.emit(msg.pressed ? 'tile_pressed' : 'tile_released', {
        tileIndex: msg.tileIndex,
      });
      // Also feed it to the game
      const game = this.engine.getGame();
      if (game && this.engine.getState() === 'running') {
        game.onSensorEvent(msg.tileIndex, msg.pressed);
      }
    }
  }

  private broadcast(msg: ServerMessage): void {
    const json = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
```

### Create a driver wrapper that also streams to WebSocket

Create `src/drivers/ws-broadcast-driver.ts`:

```typescript
import type { ITileDriver, TileUpdate, SensorEventCallback } from '@/drivers/driver.interface.js';
import type { RGB } from '@/utils/color.js';
import type { WsGameServer } from '@/server/ws-server.js';

/**
 * Wraps any ITileDriver to also broadcast tile updates via WebSocket.
 * This is the bridge between the engine and the floor simulator.
 */
export class WsBroadcastDriver implements ITileDriver {
  private readonly inner: ITileDriver;
  private readonly wsServer: WsGameServer;
  private elapsed = 0;
  private remaining = 0;

  constructor(inner: ITileDriver, wsServer: WsGameServer) {
    this.inner = inner;
    this.wsServer = wsServer;
  }

  setTimingContext(elapsed: number, remaining: number): void {
    this.elapsed = elapsed;
    this.remaining = remaining;
  }

  async connect(): Promise<void> {
    return this.inner.connect();
  }

  async disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  setTileColor(tileIndex: number, r: number, g: number, b: number): void {
    this.inner.setTileColor(tileIndex, r, g, b);
    this.wsServer.sendTileUpdate(
      [{ i: tileIndex, r, g, b }],
      this.elapsed,
      this.remaining,
    );
  }

  setAllTiles(colors: RGB[]): void {
    this.inner.setAllTiles(colors);
    const tiles = colors.map((c, i) => ({ i, r: c.r, g: c.g, b: c.b }));
    this.wsServer.sendTileUpdate(tiles, this.elapsed, this.remaining);
  }

  setBatchTiles(updates: TileUpdate[]): void {
    this.inner.setBatchTiles(updates);
    if (updates.length > 0) {
      const tiles = updates.map((u) => ({ i: u.index, r: u.r, g: u.g, b: u.b }));
      this.wsServer.sendTileUpdate(tiles, this.elapsed, this.remaining);
    }
  }

  onSensorEvent(callback: SensorEventCallback): void {
    this.inner.onSensorEvent(callback);
  }

  getTileCount(): number {
    return this.inner.getTileCount();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }
}
```

### Wire timing context into the engine tick

In the engine's `tickOnce()` method (or wherever the broadcast driver is used),
call `setTimingContext` before each tick so the WS message includes elapsed and
remaining time. The cleanest spot is after the timer update in `tickOnce()` —
but since we shouldn't modify the engine heavily, an alternative is to hook
into the `tick` event emitter and update the driver from there:

```typescript
// In server bootstrap, after creating engine and WS server:
engine.emitter.on('tick', (data) => {
  if (broadcastDriver) {
    broadcastDriver.setTimingContext(data.elapsedMs, data.remainingMs);
  }
});
```

## Task 3: Floor simulator HTML page (STR-13)

### Create `src/server/static/simulator.html`

This is a self-contained HTML file served by the arena-server that renders a
virtual LED floor grid in the browser. It:

- Connects to the server's WebSocket
- Renders a grid of colored rectangles (tiles)
- Supports click-to-simulate-sensor (sends `{ type: 'sensor', tileIndex, pressed: true }`)
- Shows game state: timer, scores, current game name
- Auto-reconnects on disconnect

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Arena Floor Simulator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    #status {
      padding: 8px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .connected { background: #064e3b; color: #6ee7b7; }
    .disconnected { background: #7f1d1d; color: #fca5a5; }
    .waiting { background: #78350f; color: #fcd34d; }
    #info-bar {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
      font-size: 16px;
    }
    #info-bar span { opacity: 0.7; }
    #info-bar strong { opacity: 1; }
    #grid-container {
      display: inline-grid;
      gap: 2px;
      padding: 8px;
      background: #111;
      border-radius: 8px;
    }
    .tile {
      width: 40px;
      height: 40px;
      border-radius: 4px;
      cursor: pointer;
      transition: background-color 0.05s;
      position: relative;
    }
    .tile:hover { opacity: 0.8; }
    .tile:active { transform: scale(0.9); }
    .tile .index {
      position: absolute;
      bottom: 1px;
      right: 3px;
      font-size: 8px;
      color: rgba(255,255,255,0.3);
      pointer-events: none;
    }
    #scores {
      margin-top: 16px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .score-card {
      background: #1a1a1a;
      padding: 12px 20px;
      border-radius: 8px;
      text-align: center;
    }
    .score-card .name { font-size: 12px; opacity: 0.7; }
    .score-card .value { font-size: 28px; font-weight: bold; }
  </style>
</head>
<body>
  <h1 style="margin-bottom: 12px; font-size: 24px;">Arena Floor Simulator</h1>
  <div id="status" class="disconnected">Disconnected</div>
  <div id="info-bar">
    <div>Game: <strong id="game-name">—</strong></div>
    <div>Time: <strong id="timer">0:00</strong></div>
  </div>
  <div id="grid-container"></div>
  <div id="scores"></div>

  <script>
    const ROWS = 16;
    const COLS = 12;
    const DEFAULT_COLOR = '#1f2937';

    let ws = null;
    let tiles = [];
    let gridRows = ROWS;
    let gridCols = COLS;
    let reconnectTimer = null;

    function initGrid(rows, cols) {
      gridRows = rows;
      gridCols = cols;
      const container = document.getElementById('grid-container');
      container.style.gridTemplateColumns = `repeat(${cols}, 40px)`;
      container.innerHTML = '';
      tiles = [];

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const div = document.createElement('div');
          div.className = 'tile';
          div.style.backgroundColor = DEFAULT_COLOR;
          div.innerHTML = `<span class="index">${idx}</span>`;

          div.addEventListener('mousedown', () => sendSensor(idx, true));
          div.addEventListener('mouseup', () => sendSensor(idx, false));
          div.addEventListener('mouseleave', () => sendSensor(idx, false));

          container.appendChild(div);
          tiles[idx] = div;
        }
      }
    }

    function sendSensor(index, pressed) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sensor', tileIndex: index, pressed }));
      }
    }

    function setTile(index, r, g, b) {
      if (tiles[index]) {
        tiles[index].style.backgroundColor = `rgb(${r},${g},${b})`;
      }
    }

    function formatTime(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return `${m}:${String(sec).padStart(2, '0')}`;
    }

    function updateScores(scores) {
      const el = document.getElementById('scores');
      el.innerHTML = scores.map(s =>
        `<div class="score-card">
          <div class="name">${s.name}</div>
          <div class="value">${s.score}</div>
        </div>`
      ).join('');
    }

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}/ws`;

      ws = new WebSocket(url);
      document.getElementById('status').textContent = 'Connecting…';
      document.getElementById('status').className = 'waiting';

      ws.onopen = () => {
        document.getElementById('status').textContent = 'Connected';
        document.getElementById('status').className = 'connected';
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      };

      ws.onclose = () => {
        document.getElementById('status').textContent = 'Disconnected — reconnecting…';
        document.getElementById('status').className = 'disconnected';
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'tile_update') {
          for (const t of msg.tiles) {
            setTile(t.i, t.r, t.g, t.b);
          }
          document.getElementById('timer').textContent = formatTime(msg.remaining);
        }

        if (msg.type === 'game_start') {
          document.getElementById('game-name').textContent = msg.gameId;
          if (msg.grid) initGrid(msg.grid.rows, msg.grid.cols);
        }

        if (msg.type === 'game_end') {
          document.getElementById('game-name').textContent = '— Game Over —';
          updateScores(msg.scores);
        }

        if (msg.type === 'score_update') {
          // Individual score updates during gameplay
        }
      };
    }

    // Initialize with default grid and connect
    initGrid(ROWS, COLS);
    connect();
  </script>
</body>
</html>
```

### Serve the static file

In the server's HTTP setup (wherever the HTTP server is created — likely
`src/server/http-server.ts` or `src/main.ts`), add a route to serve the
simulator:

```typescript
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const simulatorHtml = readFileSync(
  join(__dirname, 'static', 'simulator.html'),
  'utf-8'
);

// In the HTTP request handler:
if (req.url === '/simulator' || req.url === '/simulator/') {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(simulatorHtml);
  return;
}
```

## Wiring it all together

In the server bootstrap (likely `src/main.ts` or `src/server/index.ts`):

```typescript
import { CatalogSync } from '@/services/catalog-sync.js';
import { WsGameServer } from '@/server/ws-server.js';
import { WsBroadcastDriver } from '@/drivers/ws-broadcast-driver.js';

// 1. Create the base driver (MockDriver for dev)
const baseDriver = new MockDriver(grid.rows * grid.cols);
await baseDriver.connect();

// 2. Create HTTP server + WS server
const httpServer = createServer(requestHandler);
const wsServer = new WsGameServer({ server: httpServer, engine });

// 3. Wrap driver with WS broadcast
const broadcastDriver = new WsBroadcastDriver(baseDriver, wsServer);

// 4. Create engine with broadcast driver
const engine = new GameEngine({ driver: broadcastDriver, grid });

// 5. Hook timing context
engine.emitter.on('tick', (data) => {
  broadcastDriver.setTimingContext(data.elapsedMs, data.remainingMs);
});

// 6. Start catalog sync
const catalogSync = new CatalogSync({ games: gamesRepo });
await catalogSync.start();

// 7. Start server
httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'Arena server running');
  logger.info(`Floor simulator: http://localhost:${PORT}/simulator`);
});
```

## Testing

1. **Catalog sync:**
   - Set env vars for Supabase
   - Start server → check logs for "Catalog sync complete"
   - Check SQLite: `SELECT slug, version FROM arena_games` should show games
     published from designer

2. **WebSocket:**
   - Open `http://localhost:3001/simulator` in browser
   - Should see "Connected" status
   - Start a game session → tiles should light up in real time

3. **Floor simulator:**
   - Click tiles in the simulator → should trigger sensor events in the game
   - Scores should update
   - Timer should count down
   - Game end should show final scores

4. **End-to-end (designer → simulator):**
   - In arena-designer, load Color Rush → click Publish
   - Wait 60s for catalog sync (or restart server)
   - Start a session with slug "color-rush"
   - See game playing in the floor simulator

```bash
bun run test         # all tests pass
bun run typecheck    # no new type errors
```

## After completion

Update Linear: mark STR-11, STR-12, and STR-13 as Done.
