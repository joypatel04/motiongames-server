# Ralph Loop — Demo Polish (Partner Sync + Game-Over + Final Test)

> **Linear:** STR-18 + STR-19 + STR-20 | **Repo:** arena-server + arena-designer
> **Day 11–13**
> **When done, update Linear:** mark STR-18, STR-19, and STR-20 as Done
> **Blocked by:** STR-15 (Launcher WS), STR-16 (Score sync), STR-19 depends
>   on STR-12 (WebSocket streaming)

## Goal

Final polish before the China hardware demo:

1. **Partner profile sync** — Sync partner/venue profiles from Supabase so the
   launcher shows the correct branding when running at a partner venue.
2. **Game-over celebration** — When a game ends, animate the floor to the
   winner's color with a celebration pattern. This was designed in the arena
   designer (V6.6 game-over phase) but needs to work end-to-end via the
   server and floor simulator.
3. **Final demo test** — Run the complete flow from designer → publish →
   server → simulator and verify everything works together.

## Important context

- Read `CLAUDE.md` for project conventions.
- The arena-designer already has game-over animations designed into Color Rush
  (the `game_over` phase with `winner_celebration` trigger). The interpreter
  handles this via `processPhases` and `checkWinCondition`.
- The launcher (V7) already has partner profiles. This task syncs them from
  Supabase rather than hardcoding.

## Task 1: Partner profile sync (STR-18)

### Supabase table: `arena_partners`

This table may or may not exist yet. If it doesn't, create it:

```sql
CREATE TABLE IF NOT EXISTS arena_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  primary_color TEXT DEFAULT '#3b82f6',
  secondary_color TEXT DEFAULT '#1e40af',
  grid_rows INTEGER DEFAULT 16,
  grid_cols INTEGER DEFAULT 12,
  tile_count INTEGER DEFAULT 192,
  address TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE arena_partners ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.arena_partners TO anon, authenticated, service_role;

CREATE POLICY partners_read ON arena_partners
  FOR SELECT USING (is_active = true);

CREATE POLICY partners_service ON arena_partners
  FOR ALL USING (true) WITH CHECK (true);

-- Seed a test partner
INSERT INTO arena_partners (name, slug, primary_color, grid_rows, grid_cols)
VALUES ('Demo Venue', 'demo-venue', '#10b981', 16, 12);
```

### arena-server: Fetch partner config on startup

Create `src/services/partner-config.ts`:

```typescript
import { getSupabaseClient } from './supabase-client.js';
import pino from 'pino';

const logger = pino({ name: 'partner-config' });

export interface PartnerProfile {
  id: string;
  name: string;
  slug: string;
  logoUrl?: string;
  primaryColor: string;
  secondaryColor: string;
  gridRows: number;
  gridCols: number;
  tileCount: number;
}

let cachedProfile: PartnerProfile | null = null;

export async function loadPartnerProfile(slug?: string): Promise<PartnerProfile | null> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    logger.warn('Supabase not configured, using default partner profile');
    return getDefaultProfile();
  }

  const partnerSlug = slug ?? process.env.PARTNER_SLUG;
  if (!partnerSlug) {
    logger.info('No PARTNER_SLUG set, using default profile');
    return getDefaultProfile();
  }

  const { data, error } = await supabase
    .from('arena_partners')
    .select('*')
    .eq('slug', partnerSlug)
    .single();

  if (error || !data) {
    logger.warn({ slug: partnerSlug, error }, 'Partner not found, using default');
    return getDefaultProfile();
  }

  cachedProfile = {
    id: data.id,
    name: data.name,
    slug: data.slug,
    logoUrl: data.logo_url,
    primaryColor: data.primary_color ?? '#3b82f6',
    secondaryColor: data.secondary_color ?? '#1e40af',
    gridRows: data.grid_rows ?? 16,
    gridCols: data.grid_cols ?? 12,
    tileCount: data.tile_count ?? 192,
  };

  logger.info({ partner: cachedProfile.name }, 'Partner profile loaded');
  return cachedProfile;
}

export function getPartnerProfile(): PartnerProfile {
  return cachedProfile ?? getDefaultProfile();
}

function getDefaultProfile(): PartnerProfile {
  return {
    id: 'default',
    name: 'Strikee Arena',
    slug: 'default',
    primaryColor: '#3b82f6',
    secondaryColor: '#1e40af',
    gridRows: Number(process.env.GRID_ROWS ?? 16),
    gridCols: Number(process.env.GRID_COLS ?? 12),
    tileCount: Number(process.env.TILE_COUNT ?? 192),
  };
}
```

### arena-designer launcher: Fetch and display partner branding

In the launcher, when connected to the server, it can request the partner
profile. Add a WS message type:

```typescript
// Server → Client
{ type: 'partner_profile', profile: PartnerProfile }
```

The server should send this on WebSocket connection. In the launcher, use it
to set the branding (logo, colors, venue name) in the kiosk UI.

### Add env var

```
PARTNER_SLUG=demo-venue
```

## Task 2: Game-over celebration polish (STR-19)

### What already works

The arena-designer's Color Rush definition includes a `game_over` phase with:
- `winner_celebration` zone that fills the floor with the winner's color
- Flash animation on the winner's tiles
- Score display widget update

The `GameInterpreter.checkWinCondition()` returns the win result, and
`processPhases()` advances to the game_over phase when the game ends.

### What needs attention

1. **Ensure the adapter communicates game-over phase** — When
   `gameState.ended = true` and `gameState.endOutcome` has a winner, the
   adapter's `tick()` should continue running for a few more seconds to play
   the celebration animation (the game_over phase), rather than immediately
   returning `finished: true`.

   In `JsonGameAdapter.tick()`, update the finish logic:

   ```typescript
   // Don't finish immediately — let the game_over phase play
   if (this.gameState.ended) {
     // Check if we're in the game_over phase
     const phases = this.definition.phases ?? this.definition.timeline?.phases ?? [];
     const currentPhase = phases[this.gameState.currentPhaseIndex];

     if (currentPhase?.id === 'game_over' || currentPhase?.name === 'game_over') {
       // Let the celebration play for its duration
       const phaseElapsed = this.elapsedMs - (this.gameState.phaseStartedAt * 1000);
       const phaseDuration = (currentPhase.duration ?? 5) * 1000;
       if (phaseElapsed >= phaseDuration) {
         return { tileUpdates, finished: true, events };
       }
     } else {
       // No game_over phase — finish after a brief delay (2s)
       if (!this.endTriggeredAt) this.endTriggeredAt = this.elapsedMs;
       if (this.elapsedMs - this.endTriggeredAt > 2000) {
         return { tileUpdates, finished: true, events };
       }
     }
   }
   ```

2. **Floor simulator shows celebration** — Since the simulator just renders
   whatever tile colors arrive via WebSocket, the celebration animation will
   "just work" as long as the server keeps ticking through the game_over phase.

3. **Send final scores over WebSocket** — The `game_end` message already
   includes scores. Verify the launcher and simulator display them prominently.

## Task 3: Final demo test (STR-20)

This is a manual testing task. Run through the complete flow and verify:

### Test script

```
1. START SERVICES
   □ arena-server running (bun run dev)
   □ arena-designer running (bun run dev)

2. PUBLISH A GAME
   □ Open arena-designer in browser
   □ Load Color Rush preset
   □ Click Publish → success toast
   □ Check Supabase dashboard → arena_games has color-rush row
     - status = 'ready'
     - definition contains full JSON
     - published_at is set

3. SERVER CATALOG SYNC
   □ Wait 60s (or restart server)
   □ Check server logs: "Catalog sync complete"
   □ Verify: server SQLite arena_games now has color-rush with definition

4. FLOOR SIMULATOR
   □ Open http://localhost:3001/simulator
   □ Should show "Connected"
   □ Grid should be 16×12

5. START A GAME
   □ Via API or launcher: start color-rush session with 2 players, medium
   □ Simulator: tiles light up, timer counting down
   □ Click tiles in simulator → scores change

6. GAME COMPLETION
   □ Let timer run out OR manually advance
   □ Game-over animation plays on floor (winner's color flood)
   □ Final scores displayed

7. SCORE SYNC
   □ Check server logs: "Score sync flushed"
   □ Check Supabase: session + scores appear in cloud tables

8. LAUNCHER (if STR-15 done)
   □ Open launcher in arena-designer
   □ Connect to server
   □ Browse games → see Color Rush
   □ Start game → plays via server
   □ Tile clicks → sensor events
   □ Game ends → scores shown

9. SECOND GAME
   □ Publish Whack-a-Mole from designer
   □ Wait for sync
   □ Play via simulator → verify different game works

10. ROBUSTNESS
    □ Disconnect simulator → reconnect → still works
    □ Publish updated Color Rush → re-sync → changes reflected
    □ Start game with 1 player → works
    □ Start game with 4 players → works
```

### Acceptance criteria

- [ ] Designer → Supabase → Server → Simulator flow works end-to-end
- [ ] At least 2 different games play correctly
- [ ] Game-over celebration visible in simulator
- [ ] Scores sync to Supabase cloud
- [ ] Launcher can browse and start games (if STR-15 done)
- [ ] No crashes or unhandled errors in a 10-minute continuous play session

### Create test results file

After running the test, create a `DEMO_TEST_RESULTS.md` in the arena-server
root with:
- Date and time of test
- Each test step: PASS / FAIL / SKIP
- Any bugs found (create Linear issues for blockers)
- Screenshots or logs of any failures

## After completion

```bash
# Both repos:
cd arena-server && bun run test && bun run typecheck
cd arena-designer && bun run test && bun run typecheck
```

Update Linear: mark STR-18, STR-19, and STR-20 as Done.
