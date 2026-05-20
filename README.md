# Motion Games Server

On-premise game engine for interactive LED arena rooms. Drives LED tiles via pluggable hardware drivers (MOKA, Ysam, or simulator), runs games, records scores locally in SQLite, and syncs to Supabase when online. Staff interact via WebSocket from a tablet or phone on the venue LAN.

**Build once, deploy to any venue.** Hardware-agnostic driver system supports multiple tile suppliers.

## How It Works

```
Staff Tablet (venue LAN)
    │ WebSocket
    ▼
┌─ motiongames-server ─────────────────────────┐
│                                               │
│  Game Engine  ←→  Session Manager  ←→  SQLite │
│       │                                  │    │
│       ▼                                  ▼    │
│  Tile Driver (abstract)           Supabase    │
│  ├── MOKA (TCP/Serial/RS485)      (cloud sync)│
│  ├── Ysam (UDP, future)                       │
│  └── Mock (dev/testing)                       │
│       │                                       │
└───────┼───────────────────────────────────────┘
        ▼
   LED Floor Tiles (192+ tiles, pressure sensors)
```

## Tech Stack

- **Runtime:** Node.js 20+ with TypeScript 5 (strict)
- **Database:** better-sqlite3 (local-first, offline-capable)
- **Cloud sync:** Supabase JS client (background sync queue)
- **WebSocket:** ws server on port 3001 for staff tablet UI
- **Hardware:** TCP (USR-N540), USB Serial (CP210x), or UDP (Ysam)
- **Testing:** Vitest
- **Build:** tsup
- **Process:** PM2 for production

## Getting Started

```bash
npm install
npm run dev          # starts with mock driver, no hardware needed
```

## Available Scripts

```bash
npm run dev              # development (mock driver)
npm run build            # production build via tsup
npm test                 # run all tests
npm run test:watch       # watch mode
npm run test:coverage    # coverage report
npm run lint             # ESLint
npm run format           # Prettier
```

### Production

```bash
npm run build
pm2 start ecosystem.config.js
```

## Project Structure

```
src/
  index.ts              Entry point
  config.ts             Environment config

  drivers/              Tile hardware abstraction
    driver.interface.ts  ITileDriver interface
    mock.driver.ts       Simulated tiles (dev/testing)
    moka.driver.ts       MOKA protocol (TCP → RS485 or USB Serial)
    ysam.driver.ts       Ysam UDP protocol (future)
    driver.factory.ts    Creates driver from config

  engine/               Game execution engine
    engine.ts            Tick loop, state machine
    grid.ts              Row/col ↔ tile address mapping
    timer.ts             Game timer with pause/resume
    events.ts            Event emitter

  games/                Game implementations
    game.interface.ts    IGame interface
    whack-a-mole.ts      Target-hitting speed game
    lava-run.ts          Dodge expanding lava zones
    race-to-light.ts     Sprint to lit tiles
    memory-match.ts      Pattern memorization
    team-battle.ts       Zone-control team game
    simon-says.ts        Sequence repetition
    color-flood.ts       Territory capture

  server/               WebSocket server for staff tablet
    ws-server.ts         WebSocket on :3001
    ws-handlers.ts       Message handlers
    ws-protocol.ts       Message type definitions

  db/                   SQLite local database
    database.ts          Connection + migrations
    repositories/        Sessions, scores, leaderboard, games, sync queue

  sync/                 Supabase cloud sync
    sync-worker.ts       Background sync processor
    supabase.client.ts   Supabase client setup

  utils/                Logging, color helpers, CRC checksums
tests/                  Mirrors src/ structure
```

## Core Abstractions

### ITileDriver — hardware layer

```typescript
interface ITileDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setTileColor(tileIndex: number, r: number, g: number, b: number): void;
  setAllTiles(colors: RGB[]): void;
  setBatchTiles(updates: TileUpdate[]): void;
  onSensorEvent(callback: (tileIndex: number, pressed: boolean) => void): void;
  getTileCount(): number;
  isConnected(): boolean;
}
```

Every driver implements this interface. The game engine never knows which hardware it's talking to.

### IGame — game logic

```typescript
interface IGame {
  readonly id: string;
  readonly name: string;
  init(grid: Grid, players: Player[], difficulty: Difficulty): void;
  tick(deltaMs: number): GameTickResult;
  onSensorEvent(tileIndex: number, pressed: boolean): void;
  getState(): GameState;
  cleanup(): void;
}
```

The engine calls `tick()` at 60fps and forwards sensor events. Games return tile color updates. Games are pure logic — no I/O, fully testable.

## Hardware Support

| Driver | Protocol | Status |
|--------|----------|--------|
| Mock | In-memory simulation | Ready (dev/testing) |
| MOKA | TCP → RS485 via USR-N540, or USB Serial | Primary target |
| Ysam | UDP (discovery, color, sensor) | Future |

## Environment Variables

```env
# Server
PORT=3000
WS_PORT=3001
NODE_ENV=development

# Hardware
DRIVER_MODE=mock              # mock | moka-tcp | moka-serial | ysam
TILE_ROWS=16
TILE_COLS=12

# MOKA TCP (via USR-N540)
MOKA_HOST=192.168.1.100
MOKA_PORT=8234

# MOKA Serial (direct USB)
MOKA_SERIAL_PORT=/dev/ttyUSB0
MOKA_BAUD_RATE=115200

# Database
SQLITE_PATH=./data/arena.db

# Supabase sync
SUPABASE_URL=
SUPABASE_ANON_KEY=
VENUE_ID=

# Logging
LOG_LEVEL=info
```

## Session Flow

```
1. Staff selects game + difficulty on tablet
2. Server creates session in SQLite
3. Players step onto the floor
4. Staff taps "Start" → engine begins tick loop
5. Engine reads sensors, runs game logic, updates tiles at 60fps
6. Game ends → scores recorded to SQLite
7. Sync worker pushes session + scores to Supabase (when online)
```

## Related

- [motiongames-designer](https://github.com/joypatel04/motiongames-designer) — visual game designer that creates the JSON game definitions this server executes

## License

Private — All rights reserved.
