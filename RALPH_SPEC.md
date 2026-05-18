# Ralph Loop Spec — arena-server Phase 1

## Objective

Build a fully working game engine for an interactive LED floor arena. When
done, running `npm run dev` should start a server that:

1. Opens a WebSocket on port 3001
2. Accepts commands: list games, create session, start game, stop game, get scores
3. Runs game logic at 60fps tick rate with a mock tile driver
4. Records sessions and scores in SQLite
5. All tests pass with `npm test`

## Completion Promise

When all tasks below are done and all tests pass, output: RALPH_DONE

## Build Order

Follow this exact sequence. After each step, run `npm test` and fix any
failures before moving to the next step.

### Step 1: Foundation
- `src/config.ts` — load .env, export typed config object
- `src/utils/logger.ts` — pino logger setup
- `src/utils/color.ts` — RGB type, HSL conversion, color helpers
- `src/utils/crc.ts` — byte sum CRC (for future protocol use)

### Step 2: Tile Driver Interface + Mock
- `src/drivers/driver.interface.ts` — ITileDriver interface:
  ```typescript
  interface ITileDriver {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    setTileColor(tileIndex: number, r: number, g: number, b: number): void;
    setAllTiles(colors: RGB[]): void;
    setBatchTiles(updates: Array<{ index: number; r: number; g: number; b: number }>): void;
    onSensorEvent(callback: (tileIndex: number, pressed: boolean) => void): void;
    getTileCount(): number;
    isConnected(): boolean;
  }
  ```
- `src/drivers/mock.driver.ts` — MockDriver:
  - Stores tile colors in memory array
  - Simulates sensor events at configurable rate
  - Logs color changes at debug level
  - Emits random sensor press/release events for testing
- `src/drivers/driver.factory.ts` — creates driver from config
- `tests/drivers/mock.driver.test.ts`

### Step 3: Grid
- `src/engine/grid.ts` — Grid class:
  - Constructor takes rows, cols
  - `tileIndex(row, col)` → linear index
  - `tilePosition(index)` → { row, col }
  - `neighbors(index)` → adjacent tile indices (4-directional)
  - `distance(a, b)` → Manhattan distance
  - `isValid(row, col)` → bounds check
  - `randomTile()` → random valid index
  - `allTiles()` → iterator of all indices
  - Support for serpentine layout (MOKA alternates row direction)
- `tests/engine/grid.test.ts`

### Step 4: Game Engine
- `src/engine/events.ts` — typed event emitter (game_start, game_end, score_update, tile_pressed)
- `src/engine/timer.ts` — GameTimer with start/pause/resume/stop, elapsed, remaining
- `src/engine/engine.ts` — GameEngine class:
  - Takes ITileDriver, Grid, event emitter
  - `loadGame(game: IGame, players, difficulty)` → prepare
  - `start()` → begins tick loop (setInterval at ~16ms for 60fps)
  - `pause()` / `resume()` / `stop()`
  - Each tick: calls `game.tick(deltaMs)`, applies returned tile colors via driver
  - Routes sensor events from driver to active game's `onSensorEvent()`
  - Emits events on state transitions
  - State machine: idle → loaded → running → paused → completed
- `tests/engine/engine.test.ts`

### Step 5: Game Interface + 3 Games
- `src/games/game.interface.ts` — IGame interface:
  ```typescript
  interface IGame {
    readonly id: string;
    readonly name: string;
    readonly minPlayers: number;
    readonly maxPlayers: number;
    readonly defaultDuration: number;

    init(grid: Grid, players: Player[], difficulty: Difficulty): void;
    tick(deltaMs: number): GameTickResult;
    onSensorEvent(tileIndex: number, pressed: boolean): void;
    getScores(): PlayerScore[];
    getState(): object;
    cleanup(): void;
  }

  interface GameTickResult {
    tileUpdates: Array<{ index: number; r: number; g: number; b: number }>;
    finished: boolean;
    events: GameEvent[];
  }
  ```

- `src/games/whack-a-mole.ts`:
  - Random tiles light up (green), player must step on them
  - Score: +10 per hit, -5 for miss (stepping on non-lit tile)
  - Difficulty affects: number of active moles, time visible, speed increase
  - Duration: configurable (default 60s)
  - Multiplayer: each player assigned a color, scores tracked independently

- `src/games/lava-run.ts`:
  - Safe path through grid, lava tiles expand over time
  - Players must reach the end zone before lava catches them
  - Score: based on distance covered + time survived
  - Difficulty affects: lava speed, safe path width, obstacle density
  - Multiplayer: all players on grid simultaneously, last survivor wins

- `src/games/race-to-light.ts`:
  - Tiles light up one at a time, first player to step on it scores
  - Score: +10 per capture, bonus for streaks
  - Difficulty affects: time tile stays lit, distance between targets
  - Multiplayer: competitive, players race to same targets

- Tests for each game (test with mock grid, verify scoring, verify tick produces valid tile updates)

### Step 6: SQLite Database
- `src/db/database.ts`:
  - Initialize better-sqlite3 connection
  - Run migrations on startup (create tables if not exist)
  - WAL mode enabled for concurrent reads
  - Prepared statement cache
- `src/db/migrations/001_initial.sql` — all tables from CLAUDE.md domain model
- `src/db/repositories/games.repo.ts` — CRUD for game catalog + seed default games
- `src/db/repositories/sessions.repo.ts` — create, update status, get by id/date
- `src/db/repositories/scores.repo.ts` — create batch, get by session, update
- `src/db/repositories/leaderboard.repo.ts` — upsert after game, get top N
- `src/db/repositories/sync-queue.repo.ts` — enqueue, dequeue unsynced, mark synced
- `tests/db/sessions.repo.test.ts` (use in-memory SQLite for tests)

### Step 7: Session Manager
- `src/server/session-manager.ts`:
  - Orchestrates the full flow: create session → add players → start game → play → end → record scores → update leaderboard
  - Methods: createSession(), addPlayers(), startGame(), endGame(), getSessionResult()
  - Wires together: GameEngine + DB repositories + event emitter
  - On game end: writes scores to DB, updates leaderboard, enqueues sync

### Step 8: WebSocket Server
- `src/server/ws-protocol.ts` — message types:
  ```typescript
  // Client → Server
  type ClientMessage =
    | { type: 'list_games' }
    | { type: 'create_session'; gameId: string; players: string[]; difficulty: string }
    | { type: 'start_game' }
    | { type: 'stop_game' }
    | { type: 'pause_game' }
    | { type: 'resume_game' }
    | { type: 'get_status' }
    | { type: 'get_leaderboard'; gameId: string }
    | { type: 'get_history'; limit: number }

  // Server → Client
  type ServerMessage =
    | { type: 'games_list'; games: Game[] }
    | { type: 'session_created'; sessionId: string }
    | { type: 'game_started'; gameId: string }
    | { type: 'game_ended'; scores: PlayerScore[] }
    | { type: 'game_state'; state: object }  // sent every tick or on request
    | { type: 'tile_update'; tiles: TileColor[] }  // real-time tile state
    | { type: 'leaderboard'; entries: LeaderboardEntry[] }
    | { type: 'history'; sessions: SessionSummary[] }
    | { type: 'error'; message: string }
  ```
- `src/server/ws-server.ts` — WebSocket server using ws library
- `src/server/ws-handlers.ts` — handler for each message type
- `tests/server/ws-server.test.ts` — test message flow with mock WS client

### Step 9: Entry Point
- `src/index.ts`:
  - Load config
  - Initialize logger
  - Create driver (from factory based on DRIVER_MODE)
  - Connect driver
  - Initialize database (run migrations)
  - Seed default games if empty
  - Create session manager
  - Start WebSocket server
  - Log startup info
  - Handle graceful shutdown (SIGINT, SIGTERM)

### Step 10: Final Verification
- Run `npm test` — all tests must pass
- Run `npm run typecheck` — zero TypeScript errors
- Run `npm run lint` — zero lint errors
- Run `npm run dev` — server starts, logs "arena-server ready" with port info
- Verify: connect to ws://localhost:3001, send `{"type":"list_games"}`, get response

## Rules

1. Every file in `src/` must have a corresponding test in `tests/`
2. No `any` types — strict TypeScript throughout
3. Use ES module imports (import/export, not require)
4. All async operations must have proper error handling
5. SQLite tests use `:memory:` database (no file I/O in tests)
6. Mock driver must be deterministic when seeded (for reproducible tests)
7. Games must be pure — no I/O, no timers, only respond to tick() and onSensorEvent()
8. Every public function has JSDoc
9. Commit after each step passes tests

## Don't Do

- Don't build the MOKA driver (we don't have the protocol yet)
- Don't build the Ysam driver (not our hardware)
- Don't build the Supabase sync worker (Phase 2)
- Don't build a frontend/UI (separate repo)
- Don't over-engineer — working > perfect
