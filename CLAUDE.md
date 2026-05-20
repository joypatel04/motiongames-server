# CLAUDE.md — motiongames-server

## Project Overview

On-premise game engine for interactive LED floor arenas. Drives MOKA LED tiles
via TCP→RS485 (through USR-N540) or USB Serial, runs games, records scores
locally in SQLite, syncs to Supabase when online. Staff interact via WebSocket
from a tablet/phone on the venue LAN.

**First deployment:** First Break Pool & Snooker, Navsari, Gujarat, India.
192 tiles (16×12 grid), MOKA hardware.

**Business goal:** Build once, sell to other venues. This is a product, not a
one-off installation. The software must be hardware-agnostic enough to support
future tile suppliers (Ysam, DIY, etc.) via a driver plugin system.

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript 5 (strict mode)
- **Database:** better-sqlite3 (local-first, offline-capable)
- **Cloud sync:** Supabase JS client (sync queue pattern)
- **Communication:**
  - WebSocket server (ws) on port 3001 — staff tablet UI
  - TCP client — connects to USR-N540 for RS485 tile control
  - USB Serial (serialport) — direct USB-to-RS485 fallback
- **Testing:** Vitest (unit + integration)
- **Linting:** ESLint 9 + Prettier
- **Build:** tsup (fast TypeScript bundler)
- **Process:** PM2 for production process management

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   arena-server                       │
│                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │  Game     │  │ Session   │  │  Tile Driver     │ │
│  │  Engine   │  │ Manager   │  │  (abstract)      │ │
│  │          │  │           │  │                  │ │
│  │ - games/ │  │ - create  │  │ ┌──────────────┐ │ │
│  │ - logic  │  │ - score   │  │ │ MOKA Driver  │ │ │
│  │ - timer  │  │ - payment │  │ │ (TCP/Serial) │ │ │
│  │ - events │  │ - history │  │ ├──────────────┤ │ │
│  └────┬─────┘  └─────┬─────┘  │ │ Mock Driver  │ │ │
│       │              │        │ │ (dev/test)   │ │ │
│       │              │        │ ├──────────────┤ │ │
│       ▼              ▼        │ │ Ysam Driver  │ │ │
│  ┌──────────┐  ┌───────────┐  │ │ (future)     │ │ │
│  │ WebSocket│  │  SQLite   │  │ └──────────────┘ │ │
│  │ Server   │  │  (local)  │  └────────┬─────────┘ │
│  │ :3001    │  │           │           │            │
│  └────┬─────┘  └─────┬─────┘           │            │
│       │              │                 │            │
└───────┼──────────────┼─────────────────┼────────────┘
        │              │                 │
        ▼              ▼                 ▼
   Staff tablet    Supabase           USR-N540
   (venue LAN)     (cloud sync)      (RS485 bus → tiles)
```

## Directory Structure

```
src/
  index.ts                  — entry point, wires everything together
  config.ts                 — environment config (ports, DB path, hardware mode)

  drivers/                  — tile communication layer (ABSTRACT)
    driver.interface.ts     — ITileDriver interface definition
    mock.driver.ts          — simulated tiles for dev/testing
    moka.driver.ts          — MOKA protocol (TCP to N540 or USB serial)
    ysam.driver.ts          — Ysam UDP protocol (future)
    driver.factory.ts       — creates driver based on config

  engine/                   — game execution engine
    engine.ts               — GameEngine class (tick loop, state machine)
    grid.ts                 — Grid abstraction (row/col ↔ tile address mapping)
    timer.ts                — Game timer with pause/resume
    events.ts               — Event emitter for game events

  games/                    — individual game implementations
    game.interface.ts       — IGame interface (init, tick, onSensorEvent, cleanup)
    whack-a-mole.ts
    lava-run.ts
    race-to-light.ts
    memory-match.ts
    team-battle.ts
    simon-says.ts
    color-flood.ts

  server/                   — WebSocket + HTTP server
    ws-server.ts            — WebSocket server for staff tablet
    ws-handlers.ts          — message handlers (start game, stop, get status)
    ws-protocol.ts          — message type definitions

  db/                       — SQLite database layer
    database.ts             — connection, migrations, helpers
    migrations/             — SQL migration files (versioned)
    repositories/
      sessions.repo.ts      — arena_sessions CRUD
      scores.repo.ts        — arena_scores CRUD
      leaderboard.repo.ts   — arena_leaderboard aggregation
      games.repo.ts         — arena_games catalog
      sync-queue.repo.ts    — cloud sync queue

  sync/                     — Supabase cloud sync
    sync-worker.ts          — background worker processes sync queue
    supabase.client.ts      — Supabase client setup

  utils/
    logger.ts               — structured logging (pino)
    color.ts                — RGB/HSL helpers
    crc.ts                  — CRC checksum utilities

tests/
  drivers/
    mock.driver.test.ts
    moka.driver.test.ts
  engine/
    engine.test.ts
    grid.test.ts
  games/
    whack-a-mole.test.ts
    lava-run.test.ts
  server/
    ws-server.test.ts
  db/
    sessions.repo.test.ts
```

## Key Interfaces

### ITileDriver (the hardware abstraction)

```typescript
interface ITileDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setTileColor(tileIndex: number, r: number, g: number, b: number): void;
  setAllTiles(colors: RGB[]): void;
  setBatchTiles(updates: TileUpdate[]): void;
  getSensorState(tileIndex: number): boolean;
  onSensorEvent(callback: (tileIndex: number, pressed: boolean) => void): void;
  getTileCount(): number;
  isConnected(): boolean;
}
```

Every driver (mock, MOKA, Ysam, future) implements this interface. The game
engine NEVER knows which hardware it's talking to.

### IGame (the game abstraction)

```typescript
interface IGame {
  readonly id: string;
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;

  init(grid: Grid, players: Player[], difficulty: Difficulty): void;
  tick(deltaMs: number): GameTickResult;
  onSensorEvent(tileIndex: number, pressed: boolean): void;
  getState(): GameState;
  cleanup(): void;
}
```

Every game mode implements this. The engine calls `tick()` at 60fps and
forwards sensor events. Games return tile color updates via `GameTickResult`.

## Hardware Context

### MOKA System (primary)
- 192 tiles, 16×12 grid, single color per tile, pressure sensor per tile
- Controller: USB Serial (CP210x) or TCP via USR-N540
- Protocol: RS485, exact byte format TBD (will be captured via Wireshark)
- Cat 5 signal cables, Y-splitter power cables, 24V PSU
- 4 zones of ~48 tiles each

### Ysam Reference Protocol (documented, for future use)
- UDP-based: discovery on port 4629, color on 4629, polled input on 8300, events on 7800
- 8 channels × 170 pixels per controller
- 9 sensor zones per tile (capacitive)
- Full byte-level protocol documented in arena-architecture-decisions.md §25

### Mock Driver (development)
- Simulates a 16×12 grid in memory
- Random sensor events for testing
- WebSocket bridge to browser visualizer (optional)
- No hardware required

## Domain Model (SQLite local tables)

### arena_sessions
```sql
CREATE TABLE arena_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  game_id TEXT NOT NULL REFERENCES arena_games(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'completed', 'cancelled')),
  player_count INTEGER NOT NULL DEFAULT 1,
  difficulty TEXT DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  start_time TEXT,
  end_time TEXT,
  duration_seconds INTEGER,
  total_price REAL,
  payment_status TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'on_credit', 'cancelled')),
  metadata TEXT,  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
```

### arena_scores
```sql
CREATE TABLE arena_scores (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  customer_id TEXT,          -- links to Supabase customer
  player_profile_id TEXT,    -- links to Supabase player_profile
  score INTEGER DEFAULT 0,
  rank INTEGER,
  is_winner INTEGER DEFAULT 0,
  stats TEXT,  -- JSON (game-specific: reaction_time, tiles_hit, etc.)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced INTEGER NOT NULL DEFAULT 0
);
```

### arena_games
```sql
CREATE TABLE arena_games (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category TEXT DEFAULT 'action'
    CHECK (category IN ('action', 'puzzle', 'sports', 'party', 'educational', 'custom')),
  scoring_type TEXT DEFAULT 'points'
    CHECK (scoring_type IN ('points', 'time', 'survival', 'distance', 'custom')),
  min_players INTEGER DEFAULT 1,
  max_players INTEGER DEFAULT 8,
  default_duration_seconds INTEGER DEFAULT 60,
  difficulty_levels TEXT DEFAULT '["easy","medium","hard"]',  -- JSON array
  is_active INTEGER DEFAULT 1,
  is_premium INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### arena_leaderboard
```sql
CREATE TABLE arena_leaderboard (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  game_id TEXT NOT NULL REFERENCES arena_games(id),
  display_name TEXT NOT NULL,
  customer_id TEXT,
  player_profile_id TEXT,
  total_games INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  highest_score INTEGER DEFAULT 0,
  average_score REAL DEFAULT 0,
  wins INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_played_at TEXT,
  UNIQUE(game_id, display_name)
);
```

### sync_queue
```sql
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE')),
  payload TEXT NOT NULL,  -- JSON
  synced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);
```

## Environment Variables

```env
# Server
PORT=3000                          # HTTP port
WS_PORT=3001                       # WebSocket port
NODE_ENV=development               # development | production

# Hardware
DRIVER_MODE=mock                   # mock | moka-tcp | moka-serial | ysam
TILE_ROWS=16                       # grid rows
TILE_COLS=12                       # grid columns

# MOKA TCP (via USR-N540)
MOKA_HOST=192.168.1.100            # N540 IP address
MOKA_PORT=8234                     # N540 TCP port

# MOKA Serial (direct USB)
MOKA_SERIAL_PORT=/dev/ttyUSB0      # USB serial device
MOKA_BAUD_RATE=115200              # RS485 baud rate

# Ysam UDP (future)
YSAM_DISCOVERY_PORT=4629
YSAM_SENSOR_POLLED_PORT=8300
YSAM_SENSOR_EVENT_PORT=7800

# Database
SQLITE_PATH=./data/arena.db        # SQLite file location

# Supabase sync
SUPABASE_URL=https://agqnqwispnaytefftgpe.supabase.co
SUPABASE_ANON_KEY=                  # from snooker-club-sass .env
SHOP_ID=                            # this venue's shop_id

# Logging
LOG_LEVEL=info                      # debug | info | warn | error
```

## Running

```bash
# Development (mock driver, no hardware needed)
npm run dev

# Production (PM2)
npm run build
pm2 start ecosystem.config.js

# Tests
npm test                  # run all tests
npm run test:watch        # watch mode
npm run test:coverage     # coverage report

# Lint
npm run lint
npm run format
```

## Conventions

- Files: **kebab-case** (e.g., `mock.driver.ts`, `ws-server.ts`)
- All imports use path alias `@/` mapping to `src/`
- Strict TypeScript — no `any`, no implicit returns
- Every public function has JSDoc comments
- Every module has a corresponding test file
- Game implementations are pure — no side effects, no I/O, testable in isolation
- Driver layer is the ONLY place that touches hardware/network
- SQLite operations use prepared statements (no string concatenation)
- Errors are typed: `ArenaError`, `DriverError`, `GameError`
- Logging via pino with structured JSON output
- All game state is serializable (for replay/debug)

## Testing Strategy

- **Unit tests:** Every game, every driver method, every DB repository
- **Integration tests:** WebSocket message flow, game engine + mock driver
- **No E2E tests** (hardware-dependent, manual QA only)
- **Coverage target:** 80%+ on game logic, 70%+ overall
- Tests run with `DRIVER_MODE=mock` always

## Related Documentation

- `../snooker-club-sass/docs/arena-architecture-decisions.md` — full architecture doc (§1-§25)
- `../snooker-club-sass/docs/arena-architecture-decisions.md §17` — MOKA hardware deep-dive
- `../snooker-club-sass/docs/arena-architecture-decisions.md §22` — MOKA UDP protocol
- `../snooker-club-sass/docs/arena-architecture-decisions.md §23` — Wireshark capture strategy
- `../snooker-club-sass/docs/arena-architecture-decisions.md §25` — Ysam protocol reference
- `../snooker-club-sass/docs/database-architecture.md` — Supabase schema
- `../snooker-club-sass/types/supabase.ts` — generated DB types

## Build Phases

### Phase 1 — Core (Ralph Loop target)
- [ ] Project scaffold (package.json, tsconfig, vitest, eslint)
- [ ] ITileDriver interface + MockDriver
- [ ] Grid abstraction (row/col mapping, serpentine layout support)
- [ ] GameEngine (tick loop, state machine, sensor event routing)
- [ ] IGame interface + 3 starter games (Whack-a-Mole, Lava Run, Race to Light)
- [ ] SQLite schema + repositories (sessions, scores, leaderboard, games)
- [ ] WebSocket server + staff tablet protocol
- [ ] Session manager (create → start → play → end → score → payment)
- [ ] Tests for all of the above

### Phase 2 — Production readiness
- [ ] MOKA driver (TCP + Serial, after Wireshark capture)
- [ ] Supabase sync worker
- [ ] PM2 config + health monitoring
- [ ] More games (Memory Match, Team Battle, Simon Says, Color Flood)
- [ ] Browser-based tile visualizer (connects to mock driver via WS)

### Phase 3 — Product features
- [ ] Multi-venue support (SHOP_ID config)
- [ ] Game analytics and heatmaps
- [ ] Ysam driver
- [ ] Custom game SDK (let venues create games)
- [ ] Remote monitoring dashboard
