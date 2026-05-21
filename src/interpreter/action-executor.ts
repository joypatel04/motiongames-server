import type { Action } from './types/trigger.types.js';
import type { GameState } from './trigger-evaluator';
import { DEFAULT_TILE_COLOR } from './color-hex.js';

export interface ScoreChange {
  type: 'score';
  player: string;
  delta: number;
  /**
   * V6.6 — when set, the apply step also updates `playerCombo[player]`
   * to this count + stamps `lastHitAt` at the current game time. The
   * action-executor computes the count from the combo window/max so the
   * applier doesn't have to reproduce that logic.
   */
  comboCount?: number;
  /** V6.6 — combo decay window in seconds; stamped on `playerCombo` so
   *  the engine can drop the multiplier back to 0 after silence. */
  comboWindow?: number;
}
export interface TileChange {
  type: 'tile';
  tileIndex: number;
  color?: string;
  flash?: boolean;
}
export interface ZoneChange {
  type: 'zone';
  zoneId: string;
  add?: number[];
  remove?: number[];
  replace?: number[];
}
export interface GameEnd {
  type: 'end';
  outcome: 'win' | 'lose';
  player?: string;
}
export interface SpawnChange {
  type: 'spawn';
  zoneId?: string;
  tileIndex?: number;
  color?: string;
  /** V5 — owner player (for colour-per-player race games). */
  player?: string;
  /** V5 — seconds to wait after a collect before respawning. */
  respawnDelay?: number;
  /**
   * V6.2 — seconds a spawn lives before auto-despawning (Whack-a-Mole
   * TTL). 0 / undefined = persists forever until collected.
   */
  ttl?: number;
  /**
   * V6.3 — how many active player-owned spawns the engine should
   * maintain on the floor for this player. 1 / undefined = legacy
   * single-mole-per-player. Set via the spawn action `count` param.
   */
  count?: number;
  /**
   * V6.5 — target SIZE: how many tiles this spawn occupies as ONE
   * collectible target. 'single' (default) = 1 tile, 'bar' = 2 adjacent
   * tiles (h/v random), 'square' = 2×2 cluster. Tapping ANY tile of a
   * multi-tile cluster despawns the whole thing for one score event.
   */
  size?: 'single' | 'bar' | 'square';
}
export interface SoundChange {
  type: 'sound';
  name: string;
}
export interface PhaseChange {
  type: 'phase';
  /** undefined = advance to next phase; otherwise set to this phase id */
  phaseId?: string;
}
export interface SpeedChange {
  type: 'speed';
  variable?: string;
  value: number;
  multiplier?: boolean;
}

export type StateChange =
  | ScoreChange
  | TileChange
  | ZoneChange
  | GameEnd
  | SpawnChange
  | SoundChange
  | PhaseChange
  | SpeedChange;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Resolve a numeric action param. If it's already a number, use it. If
 * it's a "$variable" reference, look it up in gameState.activeVariables.
 * Falls back to `fallback` if neither applies.
 */
function numVar(v: unknown, gameState: GameState, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.startsWith('$')) {
    const resolved = gameState.activeVariables[v.slice(1)];
    if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved;
  }
  return fallback;
}

export function execute(action: Action, gameState: GameState): StateChange[] {
  const p = action.params ?? {};
  switch (action.type) {
    case 'score': {
      // V5 — resolve `$lastCollectedOwner` so multiplayer colour-races can
      // attribute the point to whichever player owned the just-collected
      // spawn (vs. always crediting player1).
      let player = str(p['player'], 'player1');
      if (player === '$lastCollectedOwner') {
        player = gameState.lastCollectedOwner ?? 'player1';
      }
      // V6 — resolve `$variable` references in `amount` so per-variant
      // difficulty tuning (e.g. master = `$hit_score` of 2) flows through.
      const base = numVar(p['amount'], gameState, 10);
      // V6.6 — combo multiplier. When `combo: true`, look up the owner's
      // current combo, increment if the previous hit was within
      // comboWindow seconds, otherwise reset to 1. Cap at comboMax.
      // The multiplier scales the awarded delta; the applier writes the
      // new count back to playerCombo via `comboCount` on the change.
      const useCombo = p['combo'] === true;
      let delta = base;
      let comboCount: number | undefined;
      let comboWindow: number | undefined;
      if (useCombo) {
        comboWindow = numVar(p['comboWindow'], gameState, 2.5);
        const max = Math.max(1, Math.floor(numVar(p['comboMax'], gameState, 5)));
        const prev = gameState.playerCombo[player];
        const stillActive =
          prev != null &&
          prev.count > 0 &&
          gameState.time - prev.lastHitAt <= comboWindow;
        comboCount = stillActive ? Math.min(max, prev!.count + 1) : 1;
        delta = base * comboCount;
      }
      return [
        {
          type: 'score',
          player,
          delta,
          comboCount,
          comboWindow,
        },
      ];
    }
    case 'flash': {
      const tileIndex = num(p['tile'], -1);
      if (tileIndex < 0) return [];
      return [
        { type: 'tile', tileIndex, color: str(p['color'], '#ffffff'), flash: true },
      ];
    }
    case 'color_change': {
      const tileIndex = num(p['tile'], -1);
      if (tileIndex < 0) return [];
      return [{ type: 'tile', tileIndex, color: str(p['color'], '#ffffff') }];
    }
    case 'spawn': {
      const player = typeof p['player'] === 'string' ? (p['player'] as string) : undefined;
      // V5 — when the action targets a specific player but that player
      // isn't in the active roster (e.g. a 4-player preset previewed with
      // 2 players), drop the spawn silently instead of producing a target
      // for a player who isn't on the floor.
      if (player && !gameState.activePlayers.includes(player)) {
        return [];
      }
      const respawnDelay = numVar(p['respawnDelay'], gameState, 0);
      const ttl = numVar(p['ttl'], gameState, 0);
      const count = numVar(p['count'], gameState, 1);
      // V6.5 — target size param: string ('single'|'bar'|'square') OR
      // numeric encoding (1|2|4) for $variable resolution. The numeric
      // form lets authors drive size from a difficulty variable via the
      // same numVar pathway used for ttl/count.
      const rawSize = p['size'];
      let size: 'single' | 'bar' | 'square' | undefined;
      if (rawSize === 'single' || rawSize === 'bar' || rawSize === 'square') {
        size = rawSize;
      } else {
        const sizeNum = numVar(rawSize, gameState, 1);
        size = sizeNum >= 4 ? 'square' : sizeNum >= 2 ? 'bar' : 'single';
      }
      return [
        {
          type: 'spawn',
          zoneId: typeof p['zone'] === 'string' ? p['zone'] : undefined,
          tileIndex: typeof p['tile'] === 'number' ? (p['tile'] as number) : undefined,
          color: str(p['color'], '#facc15'),
          player,
          respawnDelay: respawnDelay > 0 ? respawnDelay : undefined,
          ttl: ttl > 0 ? ttl : undefined,
          count: count > 1 ? count : undefined,
          size: size !== 'single' ? size : undefined,
        },
      ];
    }
    case 'despawn': {
      const tileIndex = num(p['tile'], -1);
      if (tileIndex < 0) return [];
      return [{ type: 'tile', tileIndex, color: DEFAULT_TILE_COLOR }];
    }
    case 'win': {
      return [{ type: 'end', outcome: 'win', player: str(p['player'], 'player1') }];
    }
    case 'lose': {
      return [{ type: 'end', outcome: 'lose', player: str(p['player'], 'player1') }];
    }
    case 'sound': {
      return [{ type: 'sound', name: str(p['name'], 'beep') }];
    }
    case 'move_zone':
    case 'expand_zone':
    case 'shrink_zone': {
      const zoneId = str(p['zone']);
      if (!zoneId) return [];
      const tiles = Array.isArray(p['tiles'])
        ? (p['tiles'] as number[]).filter((n) => typeof n === 'number')
        : [];
      if (action.type === 'shrink_zone') return [{ type: 'zone', zoneId, remove: tiles }];
      if (action.type === 'move_zone') return [{ type: 'zone', zoneId, replace: tiles }];
      return [{ type: 'zone', zoneId, add: tiles }];
    }
    case 'speed_change': {
      const variable = typeof p['variable'] === 'string' ? (p['variable'] as string) : undefined;
      const value = num(p['value'], 1);
      const multiplier = p['mode'] === 'multiplier';
      return [{ type: 'speed', variable, value, multiplier }];
    }
    case 'next_phase': {
      const phaseId = typeof p['phase'] === 'string' ? (p['phase'] as string) : undefined;
      return [{ type: 'phase', phaseId }];
    }
    case 'custom':
    default:
      void gameState;
      return [];
  }
}
