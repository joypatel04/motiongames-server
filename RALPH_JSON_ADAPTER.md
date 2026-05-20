# Ralph Loop — JSON Game Adapter (Engine Port + IGame Bridge)

> **Linear:** STR-8 + STR-9 + STR-10 | **Repo:** arena-server | **Day 3–4**
> **When done, update Linear:** mark STR-8, STR-9, and STR-10 as Done

## Goal

Port the GameInterpreter engine from arena-designer into arena-server, build a
`JsonGameAdapter` class that wraps it and implements the existing `IGame`
interface, then update the session manager's game factory so JSON-defined games
loaded from the `arena_games` SQLite table (or Supabase) can be played through
the exact same session lifecycle as the current hard-coded games.

**After this, any game definition published from the designer can be loaded and
played on the server — no code changes needed per game.**

## Important context

- Read `CLAUDE.md` for project conventions.
- The existing hard-coded games (WhackAMole, LavaRun, RaceToLight) must keep
  working. JSON games are an *addition*, not a replacement.
- The server uses RGB objects `{ r, g, b }` everywhere (see `src/utils/color.ts`).
  The designer engine uses hex strings (`#ff0000`). The adapter must convert.
- The server's `Grid` class has serpentine support. The designer's interpreter
  doesn't know about serpentine — it works on flat indices. This is fine; the
  adapter just passes rows/cols to the interpreter. The driver handles physical
  tile mapping.
- arena-server uses `@/*` path alias mapping to `src/*`.

## Task 1: Copy GameInterpreter engine (STR-8)

### What to copy

Copy these files from `arena-designer/src/engine/` and `arena-designer/src/types/`
into a new `src/engine/json-game/` directory in arena-server:

```
src/engine/json-game/
  interpreter.ts          ← from arena-designer/src/engine/interpreter.ts
  trigger-evaluator.ts    ← from arena-designer/src/engine/trigger-evaluator.ts
  action-executor.ts      ← from arena-designer/src/engine/action-executor.ts
  interpolator.ts         ← from arena-designer/src/engine/interpolator.ts
  zone-resolver.ts        ← from arena-designer/src/engine/zone-resolver.ts
  spawn-placement.ts      ← from arena-designer/src/engine/spawn-placement.ts
  pattern.ts              ← from arena-designer/src/engine/pattern.ts
  types/
    game-definition.ts    ← from arena-designer/src/types/game-definition.ts
    grid.types.ts         ← from arena-designer/src/types/grid.types.ts
    timeline.types.ts     ← from arena-designer/src/types/timeline.types.ts
    trigger.types.ts      ← from arena-designer/src/types/trigger.types.ts
    physical.ts           ← from arena-designer/src/types/physical.ts
    variables.types.ts    ← from arena-designer/src/types/variables.types.ts
  index.ts                ← barrel export
```

### Adaptations needed

1. **Fix imports** — The designer uses `@/` pointing to `src/`. Arena-server
   also uses `@/` but it's a different project. All internal imports within the
   copied engine files should use relative paths between each other:
   ```typescript
   // BEFORE (in designer):
   import type { GameDefinition } from '@/types/game-definition';
   import type { TileState } from '@/types/grid.types';

   // AFTER (in server):
   import type { GameDefinition } from './types/game-definition.js';
   import type { TileState } from './types/grid.types.js';
   ```
   **Important:** Arena-server uses `.js` extensions on imports (ESM).

2. **Color utility** — The designer's engine uses a local `color.ts` with
   `hexToRgb`, `rgbToHex`, `lerpColor`, etc. Either:
   - (Preferred) Copy the designer's `src/utils/color.ts` into
     `src/engine/json-game/color-utils.ts` and update internal imports, OR
   - Rewrite the 3 functions used (hexToRgb, lerpColor, isValidHex) inline.

3. **No React / Zustand deps** — The engine files are pure TypeScript with zero
   React dependencies. They should compile cleanly in the server's Node
   environment. Verify no `import` pulls from react, zustand, konva, etc.

4. **`Math.random` vs `rng`** — The interpreter already uses an injectable RNG
   via `gameState.rng` (Mulberry32 PRNG seeded deterministically). This is
   fine for the server. No changes needed.

### Create barrel export

```typescript
// src/engine/json-game/index.ts
export { GameInterpreter } from './interpreter.js';
export type { GameState } from './trigger-evaluator.js';
export type { GameDefinition } from './types/game-definition.js';
export type { TileState } from './types/grid.types.js';
```

### Verify it compiles

```bash
bun run typecheck   # must pass with zero new errors
```

If there are type errors, fix them. Common issues:
- Missing `.js` extensions on relative imports
- `@/` imports that should be relative
- Any ambient types the designer has that the server doesn't

## Task 2: Build JsonGameAdapter (STR-9)

This is the critical bridge class. It wraps `GameInterpreter` and implements
`IGame` so the server's entire session lifecycle works unchanged.

### Create `src/games/json-game-adapter.ts`

```typescript
import type { Grid } from '@/engine/grid.js';
import type {
  Difficulty,
  IGame,
  Player,
  PlayerScore,
  GameTickResult,
  GameEvent,
} from '@/games/game.interface.js';
import type { TileUpdate } from '@/drivers/driver.interface.js';
import { GameInterpreter } from '@/engine/json-game/interpreter.js';
import type { GameState } from '@/engine/json-game/trigger-evaluator.js';
import type { GameDefinition } from '@/engine/json-game/types/game-definition.js';

/**
 * Adapts a JSON GameDefinition into the IGame interface.
 * Wraps GameInterpreter so JSON-designed games plug into the existing
 * server session lifecycle (engine, session manager, scores, sync).
 */
export class JsonGameAdapter implements IGame {
  readonly id: string;
  readonly name: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultDuration: number;

  private readonly definition: GameDefinition;
  private interpreter: GameInterpreter | null = null;
  private gameState: GameState | null = null;
  private grid: Grid | null = null;
  private players: Player[] = [];
  private elapsedMs = 0;
  private previousTileColors: Map<number, string> = new Map(); // for diffing

  constructor(definition: GameDefinition) {
    this.definition = definition;
    this.id = definition.id;
    this.name = definition.name;
    this.minPlayers = definition.players.min;
    this.maxPlayers = definition.players.max;

    // Compute default duration from definition
    // duration.seconds for fixed mode, or fallback to durationRules, or 60s
    if (definition.duration?.mode === 'fixed' && definition.duration.seconds) {
      this.defaultDuration = definition.duration.seconds * 1000;
    } else if (definition.durationRules) {
      // Use duration for 1 player, medium difficulty as default
      const onePlayer = definition.durationRules['1'] ?? Object.values(definition.durationRules)[0];
      this.defaultDuration = (onePlayer?.medium ?? 60) * 1000;
    } else {
      this.defaultDuration = 60_000;
    }
  }

  init(grid: Grid, players: Player[], difficulty: Difficulty): void {
    this.grid = grid;
    this.players = players;
    this.elapsedMs = 0;
    this.previousTileColors.clear();

    this.interpreter = new GameInterpreter(this.definition);

    // Map difficulty string to the definition's difficulty presets
    const activeDifficulty = this.resolveDifficulty(difficulty, players.length);
    this.gameState = this.interpreter.buildInitialGameState(activeDifficulty);

    // Set player count in game state
    this.gameState.scores = players.map((p) => ({
      playerIndex: p.index,
      name: p.name,
      score: this.definition.scoring?.initialScore ?? 0,
    }));

    // Override duration from durationRules if available
    if (this.definition.durationRules) {
      const playerCount = String(players.length);
      const rules = this.definition.durationRules[playerCount]
        ?? this.definition.durationRules[String(this.maxPlayers)]
        ?? Object.values(this.definition.durationRules)[0];
      if (rules && rules[difficulty]) {
        this.gameState.durationMs = rules[difficulty] * 1000;
      }
    }
  }

  tick(deltaMs: number): GameTickResult {
    if (!this.interpreter || !this.gameState) {
      return { tileUpdates: [], finished: false, events: [] };
    }

    this.elapsedMs += deltaMs;
    this.gameState.time = this.elapsedMs;

    // Run interpreter tick (fires triggers, advances phases, expires spawns, etc.)
    this.interpreter.processTimeTick(this.gameState);

    // Check win condition
    const winResult = this.interpreter.checkWinCondition(this.gameState);
    if (winResult) {
      this.gameState.ended = true;
      this.gameState.endOutcome = winResult;
    }

    // Get current frame state from interpreter
    const frameState = this.interpreter.getFrameState(
      this.elapsedMs / 1000, // interpreter works in seconds
      this.gameState,
    );

    // Diff against previous frame to produce only changed tiles
    const tileUpdates: TileUpdate[] = [];
    for (const tile of frameState) {
      const prevColor = this.previousTileColors.get(tile.index);
      const currentColor = tile.color;
      if (prevColor !== currentColor) {
        const rgb = hexToRgbForDriver(currentColor);
        tileUpdates.push({
          index: tile.index,
          r: Math.round(rgb.r * tile.brightness),
          g: Math.round(rgb.g * tile.brightness),
          b: Math.round(rgb.b * tile.brightness),
        });
        this.previousTileColors.set(tile.index, currentColor);
      }
    }

    // Collect score events
    const events: GameEvent[] = [];
    // (Score changes are tracked in gameState.scores — the session manager
    //  reads them via getScores() at finalize time)

    return {
      tileUpdates,
      finished: this.gameState.ended ?? false,
      events,
    };
  }

  onSensorEvent(tileIndex: number, pressed: boolean): void {
    if (!this.interpreter || !this.gameState) return;

    if (pressed) {
      this.interpreter.processSensorEvent(tileIndex, this.gameState);
    } else {
      this.interpreter.processSensorRelease(tileIndex, this.gameState);
    }
  }

  getScores(): PlayerScore[] {
    if (!this.gameState) return [];
    return this.gameState.scores.map((s, i) => ({
      playerIndex: s.playerIndex ?? i,
      name: s.name ?? this.players[i]?.name ?? `Player ${i + 1}`,
      score: s.score ?? 0,
      stats: {},
    }));
  }

  getState(): Record<string, unknown> {
    return {
      elapsedMs: this.elapsedMs,
      ended: this.gameState?.ended ?? false,
      phase: this.gameState?.currentPhaseIndex ?? 0,
      scores: this.gameState?.scores ?? [],
    };
  }

  cleanup(): void {
    this.interpreter = null;
    this.gameState = null;
    this.grid = null;
    this.players = [];
    this.previousTileColors.clear();
    this.elapsedMs = 0;
  }

  // --- Private helpers ---

  private resolveDifficulty(difficulty: Difficulty, playerCount: number): Record<string, unknown> | undefined {
    const presets = this.definition.difficultyPresets ?? this.definition.difficulties;
    if (!presets) return undefined;

    const preset = presets[difficulty];
    if (!preset) return presets['medium'] ?? undefined;

    // If the preset has an overrides property (V2 DifficultyPreset format), use that
    if ('overrides' in preset && preset.overrides) {
      return preset.overrides as Record<string, unknown>;
    }
    // Otherwise, the preset IS the overrides (V1 DifficultyOverrides format)
    return preset as unknown as Record<string, unknown>;
  }
}

/**
 * Convert hex color string to RGB values (0-255).
 * Handles 3-char (#f00) and 6-char (#ff0000) hex.
 */
function hexToRgbForDriver(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3
    ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
```

### Key design decisions in the adapter

1. **Hex-to-RGB conversion** — The interpreter outputs `TileState[]` with hex
   color strings. The driver expects `{ r, g, b }` integers. The adapter does
   the conversion + brightness multiplication in the `tick()` method.

2. **Frame diffing** — Rather than sending all 192 tiles every tick, the adapter
   tracks the previous frame's colors and only emits `TileUpdate`s for tiles
   that actually changed. This minimizes serial bandwidth to the Moka hardware.

3. **Duration resolution** — Color Rush and other V5+ games use `durationRules`
   keyed by player count and difficulty. The adapter resolves this in `init()`.

4. **Score mapping** — The interpreter's `gameState.scores` array maps directly
   to the `PlayerScore[]` the session manager reads at finalize.

5. **Difficulty presets** — Handles both V1 (`difficulties`) and V2
   (`difficultyPresets`) formats.

### Write a test

Create `tests/games/json-game-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { JsonGameAdapter } from '@/games/json-game-adapter.js';
import { Grid } from '@/engine/grid.js';

// Minimal valid game definition for testing
const MINIMAL_DEFINITION = {
  id: 'test-game',
  name: 'Test Game',
  description: 'A test game',
  version: '1.0.0',
  author: 'Test',
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
  grid: { rows: 4, cols: 4 },
  players: { min: 1, max: 4, colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'] },
  scoring: { type: 'points' as const, initialScore: 0, winCondition: { type: 'highest_score' as const } },
  duration: { mode: 'fixed' as const, seconds: 60 },
  difficulties: {
    easy: { speedMultiplier: 0.5 },
    medium: { speedMultiplier: 1 },
    hard: { speedMultiplier: 2 },
  },
  zones: [
    { id: 'play', name: 'play', type: 'static' as const, tiles: Array.from({ length: 16 }, (_, i) => i), color: '#1f2937', properties: {} },
  ],
  timeline: { tracks: [] },
  triggers: [],
};

describe('JsonGameAdapter', () => {
  it('implements IGame interface', () => {
    const adapter = new JsonGameAdapter(MINIMAL_DEFINITION as any);
    expect(adapter.id).toBe('test-game');
    expect(adapter.name).toBe('Test Game');
    expect(adapter.minPlayers).toBe(1);
    expect(adapter.maxPlayers).toBe(4);
    expect(adapter.defaultDuration).toBe(60_000);
  });

  it('init sets up game state', () => {
    const adapter = new JsonGameAdapter(MINIMAL_DEFINITION as any);
    const grid = new Grid(4, 4);
    adapter.init(grid, [{ index: 0, name: 'Alice' }], 'medium');
    const scores = adapter.getScores();
    expect(scores).toHaveLength(1);
    expect(scores[0].name).toBe('Alice');
    expect(scores[0].score).toBe(0);
  });

  it('tick returns tile updates', () => {
    const adapter = new JsonGameAdapter(MINIMAL_DEFINITION as any);
    const grid = new Grid(4, 4);
    adapter.init(grid, [{ index: 0, name: 'Alice' }], 'medium');

    // First tick should produce initial tile colors
    const result = adapter.tick(16);
    expect(result.finished).toBe(false);
    expect(Array.isArray(result.tileUpdates)).toBe(true);
  });

  it('cleanup resets state', () => {
    const adapter = new JsonGameAdapter(MINIMAL_DEFINITION as any);
    const grid = new Grid(4, 4);
    adapter.init(grid, [{ index: 0, name: 'Alice' }], 'medium');
    adapter.cleanup();
    expect(adapter.getScores()).toEqual([]);
  });
});
```

## Task 3: Update game factory in session manager (STR-10)

### Modify `src/server/session-manager.ts`

The current factory is a hardcoded switch statement:

```typescript
const DEFAULT_GAME_FACTORY = (slug: string): IGame => {
  switch (slug) {
    case 'whack-a-mole':
      return new WhackAMole();
    case 'lava-run':
      return new LavaRun();
    case 'race-to-light':
      return new RaceToLight();
    default:
      throw new Error(`Unknown game slug: ${slug}`);
  }
};
```

Change it to:

```typescript
import { JsonGameAdapter } from '@/games/json-game-adapter.js';

// Hard-coded games (legacy — keep working during transition)
const CODE_GAMES: Record<string, () => IGame> = {
  'whack-a-mole': () => new WhackAMole(),
  'lava-run': () => new LavaRun(),
  'race-to-light': () => new RaceToLight(),
};

export interface SessionManagerDeps {
  engine: GameEngine;
  games: GamesRepository;
  sessions: SessionsRepository;
  scores: ScoresRepository;
  leaderboard: LeaderboardRepository;
  syncQueue: SyncQueueRepository;
  gameFactory?: (slug: string, definition?: unknown) => IGame;
}
```

### Update GamesRepository to store/retrieve definitions

The SQLite `arena_games` table (from `001_initial.sql`) does NOT currently have
a `definition` column. Add a migration:

Create `src/db/migrations/002_add_definition_column.sql`:
```sql
ALTER TABLE arena_games ADD COLUMN definition TEXT;
ALTER TABLE arena_games ADD COLUMN version TEXT DEFAULT '1.0.0';
ALTER TABLE arena_games ADD COLUMN status TEXT DEFAULT 'active';
```

Update `GamesRepository` to include the definition field:

```typescript
// In games.repo.ts, update GameRow:
export interface GameRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  scoring_type: string;
  min_players: number;
  max_players: number;
  default_duration_seconds: number;
  difficulty_levels: string;
  is_active: number;
  is_premium: number;
  created_at: string;
  definition?: string;   // JSON string of GameDefinition (null for code games)
  version?: string;
  status?: string;
}

// Add method to get game with definition:
getBySlugWithDefinition(slug: string): GameRow | undefined {
  return this.db.prepare(
    'SELECT * FROM arena_games WHERE slug = ? AND is_active = 1'
  ).get(slug) as GameRow | undefined;
}
```

### Update the factory logic in SessionManager

In `createSession()`, change the game instantiation:

```typescript
createSession(input: CreateSessionInput): SessionRow {
  if (this.currentSessionId) {
    throw new Error('A session is already in progress');
  }
  const gameRow = this.games.getBySlug(input.gameSlug);
  if (!gameRow) throw new Error(`Unknown game: ${input.gameSlug}`);
  if (input.players.length === 0) throw new Error('At least one player required');

  const session = this.sessions.create({
    gameId: gameRow.id,
    playerCount: input.players.length,
    difficulty: input.difficulty,
  });
  this.currentSessionId = session.id;
  this.currentGameId = gameRow.id;
  this.currentPlayers = input.players.map((name, index) => ({ index, name }));

  // Try JSON definition first, fall back to code games
  let game: IGame;
  if (gameRow.definition) {
    const definition = JSON.parse(gameRow.definition);
    game = new JsonGameAdapter(definition);
  } else if (CODE_GAMES[input.gameSlug]) {
    game = CODE_GAMES[input.gameSlug]();
  } else {
    throw new Error(`No game implementation for slug: ${input.gameSlug}`);
  }

  this.engine.loadGame(game, this.currentPlayers, input.difficulty);
  return session;
}
```

### Update the default game factory

Replace `DEFAULT_GAME_FACTORY` with the updated inline logic shown above, OR
keep the factory pattern and pass a `games` repo reference:

```typescript
const createGameFactory = (games: GamesRepository) => (slug: string): IGame => {
  const gameRow = games.getBySlugWithDefinition(slug);

  // If the game has a JSON definition, use the adapter
  if (gameRow?.definition) {
    const definition = JSON.parse(gameRow.definition);
    return new JsonGameAdapter(definition);
  }

  // Fall back to hard-coded games
  if (CODE_GAMES[slug]) return CODE_GAMES[slug]();
  throw new Error(`Unknown game slug: ${slug}`);
};
```

This approach keeps the factory injectable for tests while adding JSON game
support.

## Testing

1. Run existing tests — nothing should break:
   ```bash
   bun run test
   ```

2. Verify typecheck passes:
   ```bash
   bun run typecheck
   ```

3. Manual test with a JSON game:
   ```bash
   # Insert a test game definition into SQLite
   # (you can use the Color Rush JSON from the designer's presets)
   bun run dev
   # Then via the API or directly:
   # POST /api/sessions { gameSlug: "color-rush", players: ["Alice", "Bob"], difficulty: "medium" }
   ```

4. Test that hard-coded games still work:
   ```bash
   # POST /api/sessions { gameSlug: "whack-a-mole", players: ["Alice"], difficulty: "easy" }
   ```

## After completion

```bash
bun run test         # all tests pass
bun run typecheck    # no new type errors
```

Update Linear: mark STR-8, STR-9, and STR-10 as Done.
