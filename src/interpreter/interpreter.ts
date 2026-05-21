import type { GameDefinition } from './types/game-definition.js';
import type { TileState } from './types/grid.types.js';
import type { Keyframe, Track, TimelinePhase } from './types/timeline.types.js';
import type { Trigger } from './types/trigger.types.js';
import { interpolateColor, interpolateBrightness } from './interpolator';
import {
  evaluate,
  evaluateSequence,
  type GameState,
  type TargetCluster,
  makeInitialGameState,
} from './trigger-evaluator';
import { execute, type StateChange } from './action-executor';
import { applyPattern } from './pattern';
import { resolveZoneTiles } from './zone-resolver';
import { DEFAULT_TILE_COLOR } from './color-hex.js';
import {
  effectivePhysical,
  type PhysicalConfig,
} from './types/physical.js';
import {
  expandClusterFromAnchor,
  pickReachableCluster,
  playerAnchor,
} from './spawn-placement';

export { DEFAULT_TILE_COLOR };

/**
 * Context the reachability helpers need but `applyChangesToGameState`
 * doesn't otherwise carry: the effective physical config + grid dims.
 * Cached on `GameInterpreter` and threaded through to keep these helpers
 * pure (no `this` dependency).
 */
interface PlacementCtx {
  physical: PhysicalConfig;
  grid: { rows: number; cols: number };
}

/**
 * V6.5 — Atomically register a multi-tile target cluster. Writes the
 * cluster record AND the per-tile caches (activeSpawns, owners, expiry,
 * tileToCluster) in lock-step so the invariant
 *   "for every tile in activeSpawns, tileToCluster[tile] points to a
 *    cluster containing that tile"
 * always holds. The cluster id is returned for callers that need it.
 *
 * This is the ONLY sanctioned writer for cluster + per-tile maps.
 * Inline writes to activeSpawns or tileToCluster anywhere else risk
 * desync. (One audited exception: `getFrameState` only READS the maps.)
 */
function createCluster(
  gs: GameState,
  spec: {
    tiles: number[];
    color: string;
    shape: 'single' | 'bar-h' | 'bar-v' | 'square';
    owner?: string;
    expiresAt?: number;
  },
): TargetCluster {
  const id = `c_${gs.nextClusterId++}`;
  const cluster: TargetCluster = {
    id,
    color: spec.color,
    tiles: [...spec.tiles],
    shape: spec.shape,
    owner: spec.owner,
    expiresAt: spec.expiresAt,
  };
  gs.clusters[id] = cluster;
  for (const tile of spec.tiles) {
    gs.activeSpawns[tile] = spec.color;
    gs.tileToCluster[tile] = id;
    if (spec.owner) gs.activeSpawnOwners[tile] = spec.owner;
    if (spec.expiresAt != null) gs.activeSpawnExpiresAt[tile] = spec.expiresAt;
  }
  return cluster;
}

/**
 * V6.5 — Atomically destroy a cluster. Removes every tile of the cluster
 * from all per-tile maps + the cluster record. Safe to call with an
 * unknown / already-deleted id (no-op).
 *
 * Returns the destroyed cluster (or null) so the caller can fan flashes,
 * pending-respawn queues, etc. across the freed tiles.
 */
function destroyCluster(gs: GameState, clusterId: string): TargetCluster | null {
  const cluster = gs.clusters[clusterId];
  if (!cluster) return null;
  for (const tile of cluster.tiles) {
    delete gs.activeSpawns[tile];
    delete gs.activeSpawnOwners[tile];
    delete gs.activeSpawnExpiresAt[tile];
    delete gs.tileToCluster[tile];
  }
  delete gs.clusters[clusterId];
  return cluster;
}

function applyChangesToGameState(
  changes: StateChange[],
  gameState: GameState,
  ctx: PlacementCtx,
): void {
  for (const c of changes) {
    if (c.type === 'score') {
      gameState.scores[c.player] = (gameState.scores[c.player] ?? 0) + c.delta;
      // V6.6 — when the score change carries a combo count (combo-aware
      // score action), update the owner's combo state. The executor
      // already did the window/cap math; we just stamp the count and
      // current time so the next combo-aware action can compare against
      // it and the HUD can read the live multiplier.
      if (c.comboCount != null) {
        gameState.playerCombo[c.player] = {
          count: c.comboCount,
          lastHitAt: gameState.time,
          window: c.comboWindow ?? 2.5,
        };
      }
    } else if (c.type === 'end') {
      gameState.ended = true;
      // First end-state wins; we don't let a stray subsequent change flip a
      // loss into a win or vice versa.
      if (!gameState.endOutcome) gameState.endOutcome = c.outcome;
    } else if (c.type === 'zone') {
      if (c.replace) {
        // move_zone semantics — wholesale tile-list swap.
        gameState.zones[c.zoneId] = [...c.replace];
      } else {
        const zone = gameState.zones[c.zoneId];
        if (zone) {
          if (c.add) {
            for (const idx of c.add) if (!zone.includes(idx)) zone.push(idx);
          }
          if (c.remove) {
            gameState.zones[c.zoneId] = zone.filter((idx) => !c.remove!.includes(idx));
          }
        }
      }
    } else if (c.type === 'spawn') {
      const color = c.color ?? '#facc15';
      const respawnDelay = typeof c.respawnDelay === 'number' ? c.respawnDelay : 0;
      const ttl = typeof c.ttl === 'number' ? c.ttl : 0;
      const count = typeof c.count === 'number' && c.count > 1 ? c.count : 0;
      const size: 'single' | 'bar' | 'square' = c.size ?? 'single';
      // Record (or refresh) the player's recipe BEFORE placement so the
      // cluster expansion can read the effective TTL/size if the spawn
      // omits them.
      if (c.player) {
        const existing = gameState.playerSpawnRecipe[c.player];
        gameState.playerSpawnRecipe[c.player] = {
          zoneId: c.zoneId ?? existing?.zoneId ?? '',
          color,
          respawnDelay: respawnDelay > 0 ? respawnDelay : (existing?.respawnDelay ?? 0),
          ttl: ttl > 0 ? ttl : (existing?.ttl ?? 0),
          count: count > 0 ? count : (existing?.count ?? 1),
          size: c.size ?? existing?.size ?? 'single',
        };
      }
      const effectiveTtl =
        ttl > 0
          ? ttl
          : c.player
            ? gameState.playerSpawnRecipe[c.player]?.ttl ?? 0
            : 0;
      const expiresAt = effectiveTtl > 0 ? gameState.time + effectiveTtl : undefined;
      if (c.tileIndex != null) {
        // Explicit-tile spawn (e.g. logic keyframe). Expand the cluster
        // around the requested tile if size > single AND the requested
        // shape fits; otherwise place a single tile at tileIndex.
        let placed: { tiles: number[]; shape: 'single' | 'bar-h' | 'bar-v' | 'square' };
        if (size === 'single') {
          placed = { tiles: [c.tileIndex], shape: 'single' };
        } else {
          const expanded = expandClusterFromAnchor(
            c.tileIndex,
            size,
            ctx.grid,
            (idx) => idx in gameState.activeSpawns,
            gameState.rng,
          );
          placed = expanded ?? { tiles: [c.tileIndex], shape: 'single' };
        }
        createCluster(gameState, {
          tiles: placed.tiles,
          color,
          shape: placed.shape,
          owner: c.player,
          expiresAt,
        });
      } else if (c.zoneId) {
        // Zone-based spawn — anchor on the player's last position (V6.4)
        // and pick a cluster of the requested shape (V6.5) within reach.
        const anchor = c.player
          ? playerAnchor(gameState, c.player, ctx.grid, gameState.activePlayers)
          : null;
        const placed = pickReachableCluster(
          gameState,
          c.zoneId,
          anchor,
          effectiveTtl,
          ctx.physical,
          ctx.grid,
          size,
        );
        if (placed != null) {
          createCluster(gameState, {
            tiles: placed.tiles,
            color,
            shape: placed.shape,
            owner: c.player,
            expiresAt,
          });
        }
      }
    } else if (c.type === 'tile' && c.flash && c.color) {
      gameState.tileFlashes[c.tileIndex] = {
        color: c.color,
        expiresAt: gameState.time + FLASH_DURATION_SEC,
      };
    } else if (c.type === 'phase') {
      // Phase advance — interpreter applies via its own helper.
      // We just defer to it at the call site by recording a marker. The
      // actual phase tracking lives on GameInterpreter (it needs definition
      // access). The marker is the field below; the interpreter inspects it
      // post-execute.
      (gameState as unknown as { _pendingPhase?: string | true })._pendingPhase =
        c.phaseId ?? true;
    } else if (c.type === 'speed') {
      // speed_change either sets a variable to `value` or multiplies it.
      const name = c.variable ?? '__speed__';
      const existing = gameState.activeVariables[name] ?? 1;
      gameState.activeVariables[name] = c.multiplier ? existing * c.value : c.value;
    } else if (c.type === 'tile' && !c.flash) {
      // Despawn pattern: tile change back to the default color clears any
      // spawn there and any persistent override. V6.5 — if the tile was
      // part of a multi-tile cluster, destroy the whole cluster (atomic)
      // so the per-tile maps + cluster record stay in lock-step.
      if (c.color === DEFAULT_TILE_COLOR || c.color == null) {
        const cid = gameState.tileToCluster[c.tileIndex];
        if (cid) destroyCluster(gameState, cid);
        delete gameState.tileOverrides[c.tileIndex];
      } else if (c.color) {
        // color_change action — persist the new color so it stays past the
        // current frame.
        gameState.tileOverrides[c.tileIndex] = c.color;
      }
    }
  }
}

// Threshold-style conditions stay true forever once crossed, so default them
// to single-shot unless the designer set a cooldown or an explicit non-default
// maxFires. Event-style conditions (on_step, on_zone_enter, on_spawn_collected)
// don't have this problem — recentlyStepped clears after each sensor event.
const THRESHOLD_CONDITIONS = new Set([
  'on_timer',
  'on_score',
  'on_zone_clear',
  'on_lives_zero',
  'on_all_targets_hit',
]);

const FLASH_DURATION_SEC = 0.25;

/**
 * V6.3 — Maintain `recipe.count` active spawns on the floor for the given
 * player. Walks the recipe's spawn zone for free tiles and places one
 * fresh owner-tagged spawn (with inherited TTL) per missing slot.
 *
 * Best-effort: if the zone runs out of candidate tiles before the count
 * is reached, the remaining slots stay empty. The caller is responsible
 * for deciding whether to retry next tick.
 *
 * Push generated StateChanges to `pushChange` so the caller can include
 * them in its returned change list. Skips players outside `activePlayers`
 * and players with no recipe.
 */
function topUpPlayerSpawns(
  gameState: GameState,
  playerId: string,
  ctx: PlacementCtx,
  pushChange: (c: StateChange) => void,
): void {
  if (!gameState.activePlayers.includes(playerId)) return;
  const recipe = gameState.playerSpawnRecipe[playerId];
  if (!recipe || !recipe.zoneId) return;
  const target = Math.max(1, recipe.count ?? 1);
  // V6.5 — count distinct CLUSTERS owned by player, not tile entries.
  // A 2×2 target is one cluster but four tile entries.
  let current = 0;
  for (const cluster of Object.values(gameState.clusters)) {
    if (cluster.owner === playerId) current++;
  }
  while (current < target) {
    // V6.4 — anchor on the player's last collected tile (or sector
    // centre pre-first-collect). V6.5 — pickReachableCluster expands
    // the requested shape and retries on collision, degrading to a
    // single tile when nothing else fits.
    const anchor = playerAnchor(gameState, playerId, ctx.grid, gameState.activePlayers);
    const placed = pickReachableCluster(
      gameState,
      recipe.zoneId,
      anchor,
      recipe.ttl,
      ctx.physical,
      ctx.grid,
      recipe.size ?? 'single',
    );
    if (placed == null) break;
    const expiresAt = recipe.ttl > 0 ? gameState.time + recipe.ttl : undefined;
    createCluster(gameState, {
      tiles: placed.tiles,
      color: recipe.color,
      shape: placed.shape,
      owner: playerId,
      expiresAt,
    });
    // Emit one SpawnChange per tile so the harness + UI see every tile
    // that lit up. assertReachable only needs to pass for ONE tile of
    // the cluster (the anchor) — the others are necessarily close.
    for (const tile of placed.tiles) {
      pushChange({
        type: 'spawn',
        zoneId: recipe.zoneId,
        tileIndex: tile,
        color: recipe.color,
        player: playerId,
      });
    }
    current++;
  }
}

/**
 * Decide if a trigger may fire this evaluation given its cooldown/maxFires
 * metadata and the firing history we've tracked in gameState.
 */
function canFire(trigger: Trigger, gameState: GameState): boolean {
  const fired = gameState.triggerFireCount[trigger.id] ?? 0;
  const isThreshold = THRESHOLD_CONDITIONS.has(trigger.condition.type);
  const effectiveMaxFires =
    trigger.maxFires != null
      ? trigger.maxFires
      : isThreshold && trigger.cooldown == null
        ? 1
        : null;
  if (effectiveMaxFires != null && effectiveMaxFires >= 0 && fired >= effectiveMaxFires) {
    return false;
  }
  if (trigger.cooldown != null && trigger.cooldown > 0) {
    const last = gameState.triggerLastFiredAt[trigger.id];
    if (last != null && gameState.time - last < trigger.cooldown) {
      return false;
    }
  }
  return true;
}

function recordFire(trigger: Trigger, gameState: GameState): void {
  gameState.triggerFireCount[trigger.id] = (gameState.triggerFireCount[trigger.id] ?? 0) + 1;
  gameState.triggerLastFiredAt[trigger.id] = gameState.time;
}

function findSurroundingKeyframes(track: Track, time: number): {
  prev: Keyframe | null;
  next: Keyframe | null;
} {
  const sorted = [...track.keyframes].sort((a, b) => a.time - b.time);
  let prev: Keyframe | null = null;
  let next: Keyframe | null = null;
  for (const kf of sorted) {
    if (kf.time <= time) prev = kf;
    else {
      next = kf;
      break;
    }
  }
  return { prev, next };
}

function tileStateAtTime(track: Track, time: number): { color?: string; brightness?: number } {
  if (track.type !== 'tile' || track.keyframes.length === 0) return {};
  const { prev, next } = findSurroundingKeyframes(track, time);
  if (!prev && !next) return {};
  let base: { color?: string; brightness?: number };
  let patternKeyframe = prev ?? next;
  let patternStart = patternKeyframe?.time ?? time;
  if (prev && !next) {
    base = { color: prev.tileState?.color, brightness: prev.tileState?.brightness };
  } else if (!prev && next) {
    base = { color: next.tileState?.color, brightness: next.tileState?.brightness };
    patternKeyframe = next;
    patternStart = next.time;
  } else if (prev && next) {
    const span = next.time - prev.time;
    const t = span <= 0 ? 1 : (time - prev.time) / span;
    const easing = prev.easing ?? 'linear';
    const colorA = prev.tileState?.color ?? DEFAULT_TILE_COLOR;
    const colorB = next.tileState?.color ?? colorA;
    const brightA = prev.tileState?.brightness ?? 1;
    const brightB = next.tileState?.brightness ?? brightA;
    base = {
      color: interpolateColor(colorA, colorB, t, easing),
      brightness: interpolateBrightness(brightA, brightB, t, easing),
    };
  } else {
    return {};
  }

  const pattern = patternKeyframe?.tileState?.pattern;
  if (!pattern || pattern === 'solid') return base;
  const out = applyPattern({
    color: base.color ?? DEFAULT_TILE_COLOR,
    brightness: base.brightness ?? 1,
    pattern,
    patternSpeed: patternKeyframe?.tileState?.patternSpeed ?? 1,
    time: time - patternStart,
  });
  return out;
}

export class GameInterpreter {
  readonly definition: GameDefinition;
  private baseTiles: TileState[];
  /**
   * V6.4 — cached physical config + grid dims for the reachability
   * helpers. Computed once at construction; threaded into the placement
   * helpers in place of looking it up on every spawn.
   */
  private placementCtx: PlacementCtx;

  constructor(definition: GameDefinition) {
    // Resolve V2 zone selectors against the definition's grid so the rest of
    // the interpreter can treat `zone.tiles` as authoritative regardless of
    // which form (V1 indices vs V2 selector) the definition used.
    const { rows, cols } = definition.grid;
    const resolvedZones = definition.zones.map((z) => ({
      ...z,
      tiles: z.selector ? resolveZoneTiles(z, rows, cols) : z.tiles,
    }));
    this.definition = { ...definition, zones: resolvedZones };
    this.placementCtx = {
      physical: effectivePhysical(this.definition),
      grid: { rows, cols },
    };
    const tiles: TileState[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push({
          index: r * cols + c,
          row: r,
          col: c,
          color: DEFAULT_TILE_COLOR,
          brightness: 1,
        });
      }
    }
    // apply zone default colors
    for (const zone of resolvedZones) {
      for (const idx of zone.tiles) {
        const t = tiles[idx];
        if (t) {
          t.color = zone.color;
          t.zoneId = zone.id;
        }
      }
    }
    this.baseTiles = tiles;
  }

  getFrameState(time: number, gameState?: GameState): TileState[] {
    // Build a fresh baseline. When a runtime gameState is supplied, zone
    // membership is whatever's in gameState.zones (which dynamic actions like
    // move_zone / expand_zone / shrink_zone mutate); otherwise fall back to
    // the static zones baked into baseTiles for the static designer preview.
    let result: TileState[];
    if (gameState) {
      result = this.baseTiles.map((t) => ({
        ...t,
        color: DEFAULT_TILE_COLOR,
        zoneId: undefined,
      }));
      for (const zone of this.definition.zones) {
        const currentTiles = gameState.zones[zone.id];
        if (!currentTiles) continue;
        for (const idx of currentTiles) {
          const t = result[idx];
          if (t) {
            t.color = zone.color;
            t.zoneId = zone.id;
          }
        }
      }
    } else {
      result = this.baseTiles.map((t) => ({ ...t }));
    }
    // Apply global timeline tile tracks at the current game time.
    this.applyTileTracks(this.definition.timeline.tracks, time, result, gameState);
    // Apply the active phase's tile tracks using phase-local time so that
    // every phase's keyframes start counting from when the phase began,
    // not from the global game clock.
    if (gameState) {
      const phases = this.definition.phases ?? this.definition.timeline?.phases ?? [];
      const phase = phases[gameState.currentPhaseIndex];
      if (phase && phase.tracks) {
        const phaseLocalTime = Math.max(0, time - gameState.phaseStartedAt);
        this.applyTileTracks(phase.tracks, phaseLocalTime, result, gameState);
      }
    }
    // Persistent color_change overrides — sit above the zone/track layer
    // but below spawns (which are the most salient thing on screen).
    if (gameState) {
      for (const [idxStr, color] of Object.entries(gameState.tileOverrides)) {
        const idx = Number(idxStr);
        const t = result[idx];
        if (t) {
          t.color = color;
        }
      }
    }
    // Active spawns override everything else (they're the most salient thing
    // on screen — the player has to react to them).
    if (gameState) {
      for (const [idxStr, color] of Object.entries(gameState.activeSpawns)) {
        const idx = Number(idxStr);
        const t = result[idx];
        if (t) {
          t.color = color;
          t.brightness = 1;
        }
      }
      // Flashes win over spawns — render on top, then expire after their
      // duration. We don't mutate gameState here (getFrameState should be
      // safe to call for any time), so just check expiry against `time`.
      for (const [idxStr, flash] of Object.entries(gameState.tileFlashes)) {
        if (flash.expiresAt <= time) continue;
        const idx = Number(idxStr);
        const t = result[idx];
        if (t) {
          t.color = flash.color;
          t.brightness = 1;
        }
      }
    }
    return result;
  }

  /**
   * Paint a set of tile tracks onto `result` using the supplied `time`.
   * Called twice from getFrameState: once with game time for global
   * timeline tracks, once with phase-local time for the active phase's
   * tracks. The second pass wins on conflicts (phase tracks ride on top
   * of the global ambience).
   */
  private applyTileTracks(
    tracks: Track[],
    time: number,
    result: TileState[],
    gameState: GameState | undefined
  ): void {
    void gameState;
    for (const track of tracks) {
      if (track.type !== 'tile') continue;
      const { color, brightness } = tileStateAtTime(track, time);
      if (color == null && brightness == null) continue;
      const target = track.target;
      if (!target || target === 'all') {
        for (const t of result) {
          if (color != null) t.color = color;
          if (brightness != null) t.brightness = brightness;
        }
        continue;
      }
      const asIndex = Number(target);
      if (Number.isFinite(asIndex) && result[asIndex]) {
        const t = result[asIndex]!;
        if (color != null) t.color = color;
        if (brightness != null) t.brightness = brightness;
        continue;
      }
      const zone = this.definition.zones.find((z) => z.id === target);
      if (zone) {
        const zoneTiles = gameState?.zones[zone.id] ?? zone.tiles;
        for (const idx of zoneTiles) {
          const t = result[idx];
          if (!t) continue;
          if (color != null) t.color = color;
          if (brightness != null) t.brightness = brightness;
        }
      }
    }
  }

  processSensorEvent(tileIndex: number, gameState: GameState): StateChange[] {
    gameState.steppedTiles.add(tileIndex);
    gameState.recentlyStepped = [tileIndex];
    // V5 — if this step is collecting a player-owned spawn, set
    // `lastCollectedOwner` BEFORE trigger evaluation so the score action's
    // `"$lastCollectedOwner"` resolves correctly inside the same cascade.
    const owner = gameState.activeSpawnOwners[tileIndex];
    if (owner) {
      gameState.lastCollectedOwner = owner;
      // Record this tile as the owner's most recent successful hit so
      // the preview's end-of-game animation can ripple from here.
      gameState.lastCollectedTile[owner] = tileIndex;
    }
    const changes: StateChange[] = [];
    // Cascade pass: keep re-evaluating triggers as long as any new one fires,
    // so that "step → score" followed by "score ≥ N → win" works regardless
    // of declaration order. Each trigger still fires at most once per sensor
    // event (tracked in `firedThisEvent`); the outer iteration cap is a
    // safety net against impossible-to-author infinite cycles.
    const firedThisEvent = new Set<string>();
    for (let iter = 0; iter < 10; iter++) {
      let progressed = false;
      for (const trigger of this.definition.triggers) {
        if (firedThisEvent.has(trigger.id)) continue;
        if (!canFire(trigger, gameState)) continue;
        const matched =
          trigger.condition.type === 'sequence'
            ? evaluateSequence(trigger.id, trigger.condition, gameState)
            : evaluate(trigger.condition, gameState);
        if (!matched) continue;
        const triggerChanges = execute(trigger.action, gameState);
        applyChangesToGameState(triggerChanges, gameState, this.placementCtx);
        changes.push(...triggerChanges);
        recordFire(trigger, gameState);
        firedThisEvent.add(trigger.id);
        progressed = true;
      }
      if (!progressed) break;
    }
    // Stepping on an active spawn collects it and produces a brief visual flash.
    // V6.5 — when the stepped tile is part of a multi-tile cluster, the
    // WHOLE cluster despawns + flashes white. One step = one collect =
    // one score (the on_spawn_collected trigger fires once per sensor
    // event, regardless of how many tiles the cluster spanned).
    if (tileIndex in gameState.activeSpawns) {
      const cid = gameState.tileToCluster[tileIndex];
      const cluster = cid ? gameState.clusters[cid] : undefined;
      const clusterTiles = cluster ? cluster.tiles : [tileIndex];
      if (cid) {
        destroyCluster(gameState, cid);
      } else {
        // Orphan tile (no cluster record — usually a test that seeded
        // activeSpawns directly). Clean up the per-tile maps so we don't
        // leak the entry.
        delete gameState.activeSpawns[tileIndex];
        delete gameState.activeSpawnOwners[tileIndex];
        delete gameState.activeSpawnExpiresAt[tileIndex];
      }
      for (const t of clusterTiles) {
        gameState.tileFlashes[t] = {
          color: '#ffffff',
          expiresAt: gameState.time + FLASH_DURATION_SEC,
        };
      }
      // V5/V6 — auto-respawn for the same owner. When the recipe's
      // respawnDelay is 0, we top up the player's active spawns
      // SYNCHRONOUSLY so the player sees fresh target(s) on the same
      // frame as the collect (no 1-frame RAF gap). When delay > 0 we
      // queue one pending refill for processTimeTick to drain after the
      // breathing window — multi-mole games on a non-zero delay get the
      // remaining slots filled by the end-of-tick top-up pass.
      if (owner) {
        const recipe = gameState.playerSpawnRecipe[owner];
        if (recipe && recipe.zoneId) {
          const delay = recipe.respawnDelay ?? 0;
          if (delay <= 0) {
            topUpPlayerSpawns(gameState, owner, this.placementCtx, (c) => changes.push(c));
          } else {
            gameState.pendingRespawns.push({
              owner,
              zoneId: recipe.zoneId,
              color: recipe.color,
              fireAt: gameState.time + delay,
            });
          }
        }
      }
    }
    gameState.recentlyStepped = [];
    return changes;
  }

  /**
   * Sensor release event. Fires any triggers whose condition is `on_release`
   * for this tile, applies their side effects to `gameState`, and returns the
   * resulting StateChanges for the UI to consume. Mirrors processSensorEvent
   * but for the off-press half of a step.
   */
  processSensorRelease(tileIndex: number, gameState: GameState): StateChange[] {
    gameState.steppedTiles.delete(tileIndex);
    gameState.recentlyReleased = [tileIndex];
    const changes: StateChange[] = [];
    for (const trigger of this.definition.triggers) {
      if (trigger.condition.type !== 'on_release') continue;
      if (!canFire(trigger, gameState)) continue;
      if (evaluate(trigger.condition, gameState)) {
        const triggerChanges = execute(trigger.action, gameState);
        applyChangesToGameState(triggerChanges, gameState, this.placementCtx);
        changes.push(...triggerChanges);
        recordFire(trigger, gameState);
      }
    }
    gameState.recentlyReleased = [];
    return changes;
  }

  /**
   * V3 — wall-button hit event. Mirrors processSensorEvent but for buttons.
   * The cascade re-evaluates triggers (including cross-surface compound
   * ones) until no more fire.
   */
  processButtonHit(buttonId: string, gameState: GameState): StateChange[] {
    gameState.hitButtons.add(buttonId);
    gameState.recentlyHitButtons = [buttonId];
    const changes: StateChange[] = [];
    const firedThisEvent = new Set<string>();
    for (let iter = 0; iter < 10; iter++) {
      let progressed = false;
      for (const trigger of this.definition.triggers) {
        if (firedThisEvent.has(trigger.id)) continue;
        if (!canFire(trigger, gameState)) continue;
        const matched =
          trigger.condition.type === 'sequence'
            ? evaluateSequence(trigger.id, trigger.condition, gameState)
            : evaluate(trigger.condition, gameState);
        if (!matched) continue;
        const triggerChanges = execute(trigger.action, gameState);
        applyChangesToGameState(triggerChanges, gameState, this.placementCtx);
        changes.push(...triggerChanges);
        recordFire(trigger, gameState);
        firedThisEvent.add(trigger.id);
        progressed = true;
      }
      if (!progressed) break;
    }
    gameState.recentlyHitButtons = [];
    return changes;
  }

  processButtonRelease(buttonId: string, gameState: GameState): StateChange[] {
    gameState.hitButtons.delete(buttonId);
    gameState.recentlyReleasedButtons = [buttonId];
    const changes: StateChange[] = [];
    for (const trigger of this.definition.triggers) {
      if (trigger.condition.type !== 'on_button_release') continue;
      if (!canFire(trigger, gameState)) continue;
      if (evaluate(trigger.condition, gameState)) {
        const triggerChanges = execute(trigger.action, gameState);
        applyChangesToGameState(triggerChanges, gameState, this.placementCtx);
        changes.push(...triggerChanges);
        recordFire(trigger, gameState);
      }
    }
    gameState.recentlyReleasedButtons = [];
    return changes;
  }

  processTimeTick(gameState: GameState): StateChange[] {
    // Drop expired flashes — they're for visual feedback only.
    for (const idxStr of Object.keys(gameState.tileFlashes)) {
      const f = gameState.tileFlashes[Number(idxStr)];
      if (f && f.expiresAt <= gameState.time) {
        delete gameState.tileFlashes[Number(idxStr)];
      }
    }
    // V2 — advance phases by elapsed time before evaluating triggers, so
    // phase-aware triggers see the right active phase.
    this.processPhases(gameState);
    const changes: StateChange[] = [];
    const firedThisTick = new Set<string>();
    for (let iter = 0; iter < 10; iter++) {
      let progressed = false;
      for (const trigger of this.definition.triggers) {
        if (firedThisTick.has(trigger.id)) continue;
        // Time ticks fire any threshold-style condition (the set of conditions
        // whose truth value persists between sensor events). Event-style
        // conditions like on_step / on_release / on_zone_enter / on_spawn_collected
        // only run from processSensorEvent because they depend on transient
        // recentlyStepped / recentlyReleased state.
        if (!THRESHOLD_CONDITIONS.has(trigger.condition.type)) continue;
        if (!canFire(trigger, gameState)) continue;
        if (!evaluate(trigger.condition, gameState)) continue;
        const triggerChanges = execute(trigger.action, gameState);
        applyChangesToGameState(triggerChanges, gameState, this.placementCtx);
        changes.push(...triggerChanges);
        recordFire(trigger, gameState);
        firedThisTick.add(trigger.id);
        progressed = true;
      }
      if (!progressed) break;
    }
    // Logic-track keyframes fire once each when the playhead has reached
    // them. We pull from both global tracks (using game time) and the
    // active phase's tracks (using phase-local time).
    this.fireLogicKeyframes(
      this.definition.timeline.tracks,
      gameState.time,
      gameState,
      changes
    );
    const phases = this.definition.phases ?? this.definition.timeline?.phases ?? [];
    const phase = phases[gameState.currentPhaseIndex];
    if (phase && phase.tracks) {
      const phaseLocalTime = Math.max(0, gameState.time - gameState.phaseStartedAt);
      this.fireLogicKeyframes(phase.tracks, phaseLocalTime, gameState, changes);
    }
    // V2 — handle any phase advance triggered by next_phase action above.
    this.processPhases(gameState);
    // V6.2 / V6.5 — sweep auto-expired CLUSTERS (Whack-a-Mole TTL).
    // Walk the canonical `clusters` record so a 2×2 with 4 tiles all
    // expiring on the same tick produces ONE despawn + ONE pending
    // respawn (not 4). Tile expiry maps are kept consistent because
    // `destroyCluster` clears them atomically.
    const expiredIds: string[] = [];
    for (const [cid, cluster] of Object.entries(gameState.clusters)) {
      if (cluster.expiresAt == null) continue;
      if (cluster.expiresAt > gameState.time) continue;
      expiredIds.push(cid);
    }
    for (const cid of expiredIds) {
      const cluster = gameState.clusters[cid];
      if (!cluster) continue;
      const owner = cluster.owner;
      destroyCluster(gameState, cid);
      if (owner) {
        const recipe = gameState.playerSpawnRecipe[owner];
        if (recipe && recipe.zoneId) {
          gameState.pendingRespawns.push({
            owner,
            zoneId: recipe.zoneId,
            color: recipe.color,
            fireAt: gameState.time + (recipe.respawnDelay ?? 0),
          });
        }
      }
    }
    // Orphan-fallback sweep: tile entries in activeSpawnExpiresAt
    // without a cluster (usually test fixtures seeding state directly).
    // Clear them per-tile so they don't accumulate indefinitely.
    for (const [idxStr, expiresAt] of Object.entries(gameState.activeSpawnExpiresAt)) {
      if (expiresAt > gameState.time) continue;
      const idx = Number(idxStr);
      if (gameState.tileToCluster[idx]) continue; // handled above
      const owner = gameState.activeSpawnOwners[idx];
      delete gameState.activeSpawns[idx];
      delete gameState.activeSpawnOwners[idx];
      delete gameState.activeSpawnExpiresAt[idx];
      if (owner) {
        const recipe = gameState.playerSpawnRecipe[owner];
        if (recipe && recipe.zoneId) {
          gameState.pendingRespawns.push({
            owner,
            zoneId: recipe.zoneId,
            color: recipe.color,
            fireAt: gameState.time + (recipe.respawnDelay ?? 0),
          });
        }
      }
    }
    // V5/V6.5 — drain pending player-owned respawns whose delay has
    // elapsed. Each pending entry produces ONE cluster (size inherited
    // from the recipe). Anchor on the owner's last collected tile so
    // delayed respawns land within the TTL window.
    if (gameState.pendingRespawns.length > 0) {
      const stillPending: typeof gameState.pendingRespawns = [];
      for (const pending of gameState.pendingRespawns) {
        if (pending.fireAt > gameState.time) {
          stillPending.push(pending);
          continue;
        }
        if (!gameState.activePlayers.includes(pending.owner)) continue;
        const recipe = gameState.playerSpawnRecipe[pending.owner];
        const ttlForReach = recipe?.ttl ?? 0;
        const anchor = playerAnchor(
          gameState,
          pending.owner,
          this.placementCtx.grid,
          gameState.activePlayers,
        );
        const placed = pickReachableCluster(
          gameState,
          pending.zoneId,
          anchor,
          ttlForReach,
          this.placementCtx.physical,
          this.placementCtx.grid,
          recipe?.size ?? 'single',
        );
        if (placed == null) {
          // Floor saturated — try again next tick.
          stillPending.push(pending);
          continue;
        }
        const expiresAt = recipe && recipe.ttl > 0 ? gameState.time + recipe.ttl : undefined;
        createCluster(gameState, {
          tiles: placed.tiles,
          color: pending.color,
          shape: placed.shape,
          owner: pending.owner,
          expiresAt,
        });
        for (const tile of placed.tiles) {
          changes.push({
            type: 'spawn',
            zoneId: pending.zoneId,
            tileIndex: tile,
            color: pending.color,
            player: pending.owner,
          });
        }
      }
      gameState.pendingRespawns = stillPending;
    }
    // V6.3 — top-up pass: maintain `recipe.count` active spawns per
    // player with respawnDelay === 0 (multi-mole games + initial seed
    // fill). Players with respawnDelay > 0 are paced by `pendingRespawns`
    // instead, so we skip them here to honour the breathing-window intent.
    for (const playerId of gameState.activePlayers) {
      const recipe = gameState.playerSpawnRecipe[playerId];
      if (!recipe) continue;
      if ((recipe.respawnDelay ?? 0) > 0) continue;
      topUpPlayerSpawns(gameState, playerId, this.placementCtx, (c) => changes.push(c));
    }
    // V6.6 — combo decay sweep: drop any combo whose owner has been
    // silent for longer than the stamped window. Keeps the HUD honest
    // (the ×N badge fades back to 1 without a fresh tap).
    for (const [owner, combo] of Object.entries(gameState.playerCombo)) {
      if (combo.count <= 0) continue;
      if (gameState.time - combo.lastHitAt > combo.window) {
        gameState.playerCombo[owner] = { ...combo, count: 0 };
      }
    }
    return changes;
  }

  private fireLogicKeyframes(
    tracks: Track[],
    time: number,
    gameState: GameState,
    changes: StateChange[]
  ): void {
    for (const track of tracks) {
      if (track.type !== 'logic') continue;
      for (const kf of track.keyframes) {
        if (!kf.logic) continue;
        if (gameState.firedKeyframes.has(kf.id)) continue;
        if (kf.time > time) continue;
        if (kf.logic.condition && !evaluate(kf.logic.condition, gameState)) continue;
        const kfChanges = execute(kf.logic.action, gameState);
        applyChangesToGameState(kfChanges, gameState, this.placementCtx);
        changes.push(...kfChanges);
        gameState.firedKeyframes.add(kf.id);
      }
    }
  }

  isGameOver(gameState: GameState): boolean {
    if (gameState.ended) return true;
    if (this.definition.duration.mode === 'fixed') {
      const secs = this.definition.duration.seconds ?? 60;
      if (gameState.time >= secs) return true;
    }
    return false;
  }

  /**
   * Evaluate the GameDefinition's win condition against current gameState.
   * Returns a synthesized end-of-game change if it triggers, or null. Engine
   * consumers (PreviewPlayer, arena-server) should call this once per frame
   * and treat the returned change like any other StateChange.
   *
   * This complements user-authored `on_score`/`on_timer → win` triggers — the
   * built-in win condition fires regardless of whether the designer wired up
   * an explicit trigger, so games that just say "first to 100" work out of
   * the box.
   */
  checkWinCondition(gameState: GameState): StateChange | null {
    if (gameState.ended) return null;
    const wc = this.definition.scoring.winCondition;
    switch (wc.type) {
      case 'reach_score': {
        if (wc.value == null) return null;
        for (const [player, score] of Object.entries(gameState.scores)) {
          if (score >= wc.value) {
            gameState.ended = true;
            gameState.endOutcome = 'win';
            return { type: 'end', outcome: 'win', player };
          }
        }
        return null;
      }
      case 'time_survival': {
        if (wc.value == null) return null;
        if (gameState.time >= wc.value) {
          gameState.ended = true;
          gameState.endOutcome = 'win';
          return { type: 'end', outcome: 'win', player: 'player1' };
        }
        return null;
      }
      case 'reach_zone': {
        if (!wc.target) return null;
        const zoneTiles = gameState.zones[wc.target];
        if (!zoneTiles) return null;
        // "Reached" means at least one tile in the target zone has been
        // stepped on during this run.
        for (const idx of zoneTiles) {
          if (gameState.steppedTiles.has(idx)) {
            gameState.ended = true;
            gameState.endOutcome = 'win';
            return { type: 'end', outcome: 'win', player: 'player1' };
          }
        }
        return null;
      }
      // highest_score, last_standing, custom are designer-authored via triggers
      // or computed at end-of-duration.
      default:
        return null;
    }
  }

  buildInitialGameState(activeDifficulty?: string): GameState {
    const state = makeInitialGameState(this.definition.duration.seconds ?? 60);
    state.scores['player1'] = this.definition.scoring.initialScore;
    for (const zone of this.definition.zones) {
      state.zones[zone.id] = [...zone.tiles];
    }
    // Seed activeVariables from definition variables + the active difficulty
    // preset's overrides. Future speed_change actions mutate these in place.
    const variables = this.definition.variables ?? {};
    const presets = this.definition.difficultyPresets ?? {};
    const preset = activeDifficulty ? presets[activeDifficulty] : undefined;
    for (const [name, v] of Object.entries(variables)) {
      const override = preset?.overrides[name];
      const raw = typeof override === 'number' ? override : v.default;
      state.activeVariables[name] = Math.max(v.min, Math.min(v.max, raw));
    }
    return state;
  }

  /**
   * Process pending phase advance markers set by next_phase actions, and
   * auto-advance when the active phase's duration has elapsed. Returns true
   * if a phase actually advanced.
   */
  processPhases(gameState: GameState): boolean {
    const phases = this.definition.phases ?? this.definition.timeline?.phases ?? [];
    if (phases.length === 0) return false;
    const pending = (gameState as unknown as { _pendingPhase?: string | true })._pendingPhase;
    let advanced = false;
    if (pending) {
      const next = typeof pending === 'string'
        ? phases.findIndex((p) => p.id === pending)
        : gameState.currentPhaseIndex + 1;
      if (next >= 0 && next < phases.length) {
        this.resetPhaseFiredKeyframes(phases[gameState.currentPhaseIndex], gameState);
        gameState.currentPhaseIndex = next;
        gameState.phaseStartedAt = gameState.time;
        gameState.phaseLoopCount = 0;
      }
      (gameState as unknown as { _pendingPhase?: string | true })._pendingPhase = undefined;
      advanced = true;
    }
    const current = phases[gameState.currentPhaseIndex];
    if (current) {
      const elapsed = gameState.time - gameState.phaseStartedAt;
      if (elapsed >= current.duration) {
        if (current.loop) {
          gameState.phaseLoopCount += 1;
          const maxLoops = current.loopCount;
          if (maxLoops == null || maxLoops < 0 || gameState.phaseLoopCount < maxLoops) {
            // Loop the same phase — reset its window and re-arm its
            // logic keyframes so they fire again next iteration.
            this.resetPhaseFiredKeyframes(current, gameState);
            gameState.phaseStartedAt = gameState.time;
            advanced = true;
          } else if (gameState.currentPhaseIndex + 1 < phases.length) {
            this.resetPhaseFiredKeyframes(current, gameState);
            gameState.currentPhaseIndex += 1;
            gameState.phaseStartedAt = gameState.time;
            gameState.phaseLoopCount = 0;
            advanced = true;
          }
        } else if (gameState.currentPhaseIndex + 1 < phases.length) {
          this.resetPhaseFiredKeyframes(current, gameState);
          gameState.currentPhaseIndex += 1;
          gameState.phaseStartedAt = gameState.time;
          gameState.phaseLoopCount = 0;
          advanced = true;
        }
      }
    }
    return advanced;
  }

  /**
   * Clear `firedKeyframes` entries belonging to the given phase's logic
   * tracks so they can fire again on the next loop / re-entry.
   */
  private resetPhaseFiredKeyframes(phase: TimelinePhase | undefined, gameState: GameState): void {
    if (!phase || !phase.tracks) return;
    for (const track of phase.tracks) {
      if (track.type !== 'logic') continue;
      for (const kf of track.keyframes) {
        gameState.firedKeyframes.delete(kf.id);
      }
    }
  }
}
