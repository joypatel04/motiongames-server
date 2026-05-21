import type { TriggerCondition } from './types/trigger.types.js';

/**
 * V6.5 — A target cluster spans 1, 2, or 4 tiles but counts as ONE
 * collectible. Stepping on ANY tile of the cluster despawns the WHOLE
 * cluster and fires a single score. The per-tile maps
 * (activeSpawns/Owners/ExpiresAt) remain as the canvas-facing view —
 * every cluster tile has an entry in all three. `clusters` is the
 * canonical source of truth; the per-tile maps are denormalised caches.
 */
export interface TargetCluster {
  id: string;
  owner?: string;
  color: string;
  tiles: number[];
  shape: 'single' | 'bar-h' | 'bar-v' | 'square';
  expiresAt?: number;
}

export interface GameState {
  time: number;
  totalDuration: number;
  scores: Record<string, number>;
  steppedTiles: Set<number>;
  recentlyStepped: number[];
  recentlyReleased: number[];
  zoneSteppedMap: Record<string, Set<number>>;
  zones: Record<string, number[]>;
  livesByPlayer: Record<string, number>;
  ended: boolean;
  endOutcome?: 'win' | 'lose';
  triggerFireCount: Record<string, number>;
  triggerLastFiredAt: Record<string, number>;
  firedKeyframes: Set<string>;
  activeSpawns: Record<number, string>;
  tileFlashes: Record<number, { color: string; expiresAt: number }>;
  tileOverrides: Record<number, string>;
  rng: () => number;
  // V2 — phase tracking
  currentPhaseIndex: number;
  phaseStartedAt: number;
  phaseLoopCount: number;
  // V2 — active variable values (defaults + difficulty overrides, mutable via speed_change)
  activeVariables: Record<string, number>;
  // V3 — wall-button event state (mirrors steppedTiles/recentlyStepped but for buttons)
  hitButtons: Set<string>;
  recentlyHitButtons: string[];
  recentlyReleasedButtons: string[];
  /** Resolved members for button zones (by zone id). */
  buttonZones: Record<string, string[]>;
  /**
   * V3 — running progress for `sequence` compound conditions. Each trigger
   * id with an active sequence holds {step, lastFiredAt}. Cleared once
   * the sequence completes or times out.
   */
  sequenceProgress: Record<string, { step: number; lastAt: number }>;
  /**
   * V5 — multiplayer color-target model. When a spawn action carries a
   * `player` param, the engine tags the spawn with that owner so the
   * engine can:
   *   • auto-respawn another target for the same owner when collected
   *   • route the score to whichever player owns the tile's color
   *   • render per-player coloured targets
   */
  activeSpawnOwners: Record<number, string>;
  /**
   * V6.2 — game-time when each active spawn auto-expires. Parallel to
   * `activeSpawns` (tile-keyed). Spawns without a TTL are absent from
   * this map and never expire. The interpreter sweeps this in
   * processTimeTick and routes expired spawns through the same recipe-
   * based respawn path collects use.
   */
  activeSpawnExpiresAt: Record<number, number>;
  /** Last spawn-owner collected — used by `$lastCollectedOwner` in actions. */
  lastCollectedOwner: string | null;
  /**
   * Recipe per player: where to respawn (zone), colour to use, the
   * delay between collection and the new target appearing, and the
   * per-spawn TTL (V6.2). Populated by spawn actions with `player`.
   */
  playerSpawnRecipe: Record<
    string,
    {
      zoneId: string;
      color: string;
      respawnDelay: number;
      ttl: number;
      /**
       * How many active spawns of this colour the engine should maintain
       * on the floor for this player. Defaults to 1 (legacy single-mole-
       * per-player behaviour). Whack-a-Mole sets count=2/3/4 by difficulty.
       */
      count: number;
      /**
       * V6.5 — target SIZE per spawn. 'single' = 1 tile (legacy);
       * 'bar' = 2 tiles (random h/v); 'square' = 4 tiles in a 2×2.
       * Stepping on ANY tile of a multi-tile cluster collects the whole
       * thing for ONE score event.
       */
      size: 'single' | 'bar' | 'square';
    }
  >;
  /**
   * Pending respawns scheduled by collection events. Processed each tick;
   * fire when `fireAt <= time`.
   */
  pendingRespawns: Array<{ owner: string; zoneId: string; color: string; fireAt: number }>;
  /**
   * Last tile index each player collected one of their colour-owned
   * spawns on. Used by the preview's end-of-game ripple animation as the
   * origin point for the winner's victory sweep.
   */
  lastCollectedTile: Record<string, number>;
  /**
   * Which player ids are actually playing this round. Spawn actions
   * targeting a player NOT in this set become no-ops, which lets one
   * preset scale from 2- to 8-player without separate definitions.
   * Defaults to all 8 if not set.
   */
  activePlayers: string[];
  /**
   * V6.5 — target clusters (the canonical source of truth for what
   * targets exist). Per-tile maps above are denormalised caches written
   * in lock-step via `createCluster` / `destroyCluster`.
   */
  clusters: Record<string, TargetCluster>;
  /** Reverse index: tile index → owning cluster id. */
  tileToCluster: Record<number, string>;
  /** Monotonic counter for stable cluster ids (`c_0`, `c_1`, ...). */
  nextClusterId: number;
  /**
   * V6.6 — combo state per OWNER (the colour's assigned player). The
   * floor sensors can't identify the physical player who stepped, so
   * combos belong to the spawn's colour — any tap on red grows red's
   * combo. Decays to count=0 when no hit lands within `window` seconds;
   * the window is stamped here at the time of the last combo-aware
   * score action so the engine can decay without re-reading params.
   */
  playerCombo: Record<string, { count: number; lastHitAt: number; window: number }>;
}

export function makeInitialGameState(totalDuration = 60): GameState {
  return {
    time: 0,
    totalDuration,
    scores: { player1: 0 },
    steppedTiles: new Set(),
    recentlyStepped: [],
    recentlyReleased: [],
    zoneSteppedMap: {},
    zones: {},
    triggerFireCount: {},
    triggerLastFiredAt: {},
    firedKeyframes: new Set(),
    activeSpawns: {},
    tileFlashes: {},
    tileOverrides: {},
    rng: Math.random,
    livesByPlayer: { player1: 3 },
    ended: false,
    currentPhaseIndex: 0,
    phaseStartedAt: 0,
    phaseLoopCount: 0,
    activeVariables: {},
    hitButtons: new Set(),
    recentlyHitButtons: [],
    recentlyReleasedButtons: [],
    buttonZones: {},
    sequenceProgress: {},
    activeSpawnOwners: {},
    activeSpawnExpiresAt: {},
    lastCollectedOwner: null,
    playerSpawnRecipe: {},
    pendingRespawns: [],
    lastCollectedTile: {},
    activePlayers: ['player1', 'player2', 'player3', 'player4', 'player5', 'player6', 'player7', 'player8'],
    clusters: {},
    tileToCluster: {},
    nextClusterId: 0,
    playerCombo: {},
  };
}

export function evaluate(condition: TriggerCondition, gameState: GameState): boolean {
  switch (condition.type) {
    case 'on_step': {
      if (condition.target == null) return gameState.recentlyStepped.length > 0;
      const idx = Number(condition.target);
      if (!Number.isFinite(idx)) {
        const zoneTiles = gameState.zones[condition.target];
        if (!zoneTiles) return false;
        return gameState.recentlyStepped.some((t) => zoneTiles.includes(t));
      }
      return gameState.recentlyStepped.includes(idx);
    }
    case 'on_release': {
      if (condition.target == null) return gameState.recentlyReleased.length > 0;
      const idx = Number(condition.target);
      if (Number.isFinite(idx)) return gameState.recentlyReleased.includes(idx);
      return false;
    }
    case 'on_timer':
      return condition.value != null && gameState.time >= condition.value;
    case 'on_score': {
      const player = condition.target ?? 'player1';
      const score = gameState.scores[player] ?? 0;
      return condition.value != null && score >= condition.value;
    }
    case 'on_zone_clear': {
      if (!condition.target) return false;
      const zoneTiles = gameState.zones[condition.target];
      if (!zoneTiles || zoneTiles.length === 0) return false;
      return zoneTiles.every((t) => gameState.steppedTiles.has(t));
    }
    case 'on_zone_enter': {
      if (!condition.target) return false;
      const zoneTiles = gameState.zones[condition.target];
      if (!zoneTiles) return false;
      return gameState.recentlyStepped.some((t) => zoneTiles.includes(t));
    }
    case 'on_lives_zero': {
      const player = condition.target ?? 'player1';
      return (gameState.livesByPlayer[player] ?? 0) <= 0;
    }
    case 'on_spawn_collected': {
      // Fires when the player just stepped on a tile that currently has an
      // active spawn. The interpreter removes the spawn AFTER evaluation, so
      // this check sees the pre-collection state.
      return gameState.recentlyStepped.some((idx) => idx in gameState.activeSpawns);
    }
    case 'on_all_targets_hit':
      return false;
    // V3 — wall button conditions
    case 'on_button_hit': {
      if (condition.target == null) return gameState.recentlyHitButtons.length > 0;
      // target may be a button id or a button-zone id
      if (gameState.recentlyHitButtons.includes(condition.target)) return true;
      const zoneBtns = gameState.buttonZones[condition.target];
      if (zoneBtns) {
        return gameState.recentlyHitButtons.some((b) => zoneBtns.includes(b));
      }
      return false;
    }
    case 'on_button_release': {
      if (condition.target == null) return gameState.recentlyReleasedButtons.length > 0;
      if (gameState.recentlyReleasedButtons.includes(condition.target)) return true;
      const zoneBtns = gameState.buttonZones[condition.target];
      if (zoneBtns) {
        return gameState.recentlyReleasedButtons.some((b) => zoneBtns.includes(b));
      }
      return false;
    }
    case 'on_all_buttons_hit': {
      if (!condition.target) return false;
      const zoneBtns = gameState.buttonZones[condition.target];
      if (!zoneBtns || zoneBtns.length === 0) return false;
      return zoneBtns.every((b) => gameState.hitButtons.has(b));
    }
    // V3 — compound conditions
    case 'and': {
      if (!condition.conditions || condition.conditions.length === 0) return false;
      return condition.conditions.every((c) => evaluate(c, gameState));
    }
    case 'or': {
      if (!condition.conditions || condition.conditions.length === 0) return false;
      return condition.conditions.some((c) => evaluate(c, gameState));
    }
    case 'sequence': {
      // `sequence` is stateful but evaluated statelessly here — the
      // interpreter calls `evaluateSequence` which mutates sequenceProgress.
      // When called directly (e.g. nested), require all sub-steps to have
      // matched simultaneously (rarely useful, but well-defined).
      return false;
    }
    case 'custom':
      return false;
    default:
      return false;
  }
}

/**
 * Advance a stateful `sequence` condition. Returns true exactly on the
 * frame the last step is satisfied. Out-of-order or stale progress is
 * reset.
 */
export function evaluateSequence(
  triggerId: string,
  condition: TriggerCondition,
  gameState: GameState
): boolean {
  if (condition.type !== 'sequence' || !condition.conditions || condition.conditions.length === 0) {
    return false;
  }
  let progress = gameState.sequenceProgress[triggerId];
  // Reset on timeout — clear progress before reading the active step.
  if (
    progress &&
    condition.timeout != null &&
    gameState.time - progress.lastAt > condition.timeout
  ) {
    delete gameState.sequenceProgress[triggerId];
    progress = undefined;
  }
  const step = progress?.step ?? 0;
  const current = condition.conditions[step];
  if (!current) return false;
  if (evaluate(current, gameState)) {
    const nextStep = step + 1;
    if (nextStep >= condition.conditions.length) {
      // Sequence complete — reset and fire.
      delete gameState.sequenceProgress[triggerId];
      return true;
    }
    gameState.sequenceProgress[triggerId] = { step: nextStep, lastAt: gameState.time };
  }
  return false;
}
