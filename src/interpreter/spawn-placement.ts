/**
 * V6.4 — Reachability-aware spawn placement.
 *
 * The engine used to pick spawn tiles uniformly at random from the zone's
 * free tiles. That's fair on Beginner (3.5s TTL → 15-tile reach) but
 * actively unfair on Master (1.2s TTL → 2-tile reach) where the chosen
 * tile could be 12 tiles away from the player — physically impossible.
 *
 * This module gives the interpreter two helpers:
 *
 *   1. `playerAnchor` — *where* reach is measured from for a given player.
 *      Uses the player's last collected tile when available (the only step
 *      we can attribute to a specific player, since the hardware doesn't
 *      carry player identity in sensor events). Falls back to the centre
 *      of the player's sector for the first spawn.
 *
 *   2. `pickReachableTile` — picks from free zone tiles, preferring those
 *      inside `reachRadius(ttl)` of the anchor. Falls back to the closest
 *      available tile when nothing is within reach, so the player has to
 *      sprint but isn't *stranded* with an impossible target.
 *
 * Both helpers are pure functions — they read GameState, they don't write
 * it. The interpreter owns the side effects (placing the spawn, setting
 * owner + expiry).
 */

import type { GameState } from './trigger-evaluator';
import {
  reachRadius,
  tileDistanceChebyshev,
  type PhysicalConfig,
} from './types/physical.js';

export type ClusterShape = 'single' | 'bar' | 'square';
export type ResolvedClusterShape = 'single' | 'bar-h' | 'bar-v' | 'square';

export interface PlacedCluster {
  tiles: number[];
  shape: ResolvedClusterShape;
}

/**
 * Centre of the player's vertical-strip sector. Multi-player splits the
 * grid into N equal vertical strips (squad-5 = 5 columns of strips); solo
 * gets the whole grid (so the seed is grid centre).
 */
function sectorCenter(
  playerId: string,
  grid: { rows: number; cols: number },
  activePlayers: string[],
): number {
  const n = Math.max(1, activePlayers.length);
  const idx = Math.max(0, activePlayers.indexOf(playerId));
  const stripWidth = Math.max(1, Math.floor(grid.cols / n));
  const stripStart = idx * stripWidth;
  const stripEnd = idx === n - 1 ? grid.cols : stripStart + stripWidth;
  const col = Math.floor((stripStart + stripEnd) / 2);
  const row = Math.floor(grid.rows / 2);
  return row * grid.cols + col;
}

/**
 * Where reach is measured from for `playerId`. Returns:
 *   • `lastCollectedTile[playerId]` if it's been set — most accurate.
 *   • Otherwise the player's sector centre (or grid centre for solo).
 *
 * Returns `null` only when the playerId is missing AND no sector can be
 * derived (degenerate input).
 */
export function playerAnchor(
  gs: GameState,
  playerId: string,
  grid: { rows: number; cols: number },
  activePlayers: string[],
): number | null {
  const last = gs.lastCollectedTile[playerId];
  if (typeof last === 'number' && Number.isFinite(last) && last >= 0) {
    return last;
  }
  if (!grid || grid.rows <= 0 || grid.cols <= 0) return null;
  return sectorCenter(playerId, grid, activePlayers);
}

/**
 * Pick a free tile in `zoneId` that the owner can reach in `ttl` seconds.
 *
 * Strategy:
 *   • If `ttl <= 0`, the constraint is off — pick uniformly at random
 *     from free zone tiles (same as the legacy behaviour).
 *   • Otherwise compute `reachRadius(ttl, physical)` and split the
 *     candidates into "in reach" vs. "out of reach." Prefer in-reach;
 *     fall back to the closest out-of-reach tile if none qualify.
 *
 * Returns `null` only when the zone is empty / saturated (no free tiles).
 */
export function pickReachableTile(
  gs: GameState,
  zoneId: string,
  anchor: number | null,
  ttl: number,
  physical: PhysicalConfig,
  cols: number,
): number | null {
  const free = (gs.zones[zoneId] ?? []).filter(
    (t) => !(t in gs.activeSpawns),
  );
  if (free.length === 0) return null;
  if (ttl <= 0 || anchor == null) {
    return free[Math.floor(gs.rng() * free.length)]!;
  }
  const radius = reachRadius(ttl, physical);
  if (radius <= 0) {
    return free[Math.floor(gs.rng() * free.length)]!;
  }
  const reachable: number[] = [];
  let closest: number | null = null;
  let closestDist = Infinity;
  for (const tile of free) {
    const d = tileDistanceChebyshev(tile, anchor, cols);
    if (d <= radius) {
      reachable.push(tile);
    } else if (d < closestDist) {
      closestDist = d;
      closest = tile;
    }
  }
  if (reachable.length > 0) {
    return reachable[Math.floor(gs.rng() * reachable.length)]!;
  }
  return closest;
}

/**
 * V6.5 — Resolve a target SHAPE into a concrete tile layout grounded at
 * `anchor` (treated as top-left for square/bar layouts). Returns null
 * when any tile of the layout is out of grid bounds OR occupied (per
 * the `occupied` predicate). Caller decides whether to retry or fall
 * back to a single-tile placement.
 *
 * 'bar' picks h/v randomly via `rng`. If the chosen orientation doesn't
 * fit (out of bounds / occupied), the other orientation is tried before
 * giving up.
 */
export function expandClusterFromAnchor(
  anchor: number,
  shape: ClusterShape,
  grid: { rows: number; cols: number },
  occupied: (idx: number) => boolean,
  rng: () => number,
): PlacedCluster | null {
  const { rows, cols } = grid;
  const row = Math.floor(anchor / cols);
  const col = anchor % cols;
  const inBounds = (r: number, c: number): boolean =>
    r >= 0 && r < rows && c >= 0 && c < cols;
  const tileAt = (r: number, c: number): number => r * cols + c;
  const tryLayout = (tiles: number[]): boolean => {
    for (const t of tiles) {
      if (occupied(t)) return false;
    }
    return true;
  };

  if (shape === 'single') {
    if (!inBounds(row, col) || occupied(anchor)) return null;
    return { tiles: [anchor], shape: 'single' };
  }
  if (shape === 'square') {
    if (!inBounds(row + 1, col + 1)) return null;
    const tiles = [
      anchor,
      tileAt(row, col + 1),
      tileAt(row + 1, col),
      tileAt(row + 1, col + 1),
    ];
    if (!tryLayout(tiles)) return null;
    return { tiles, shape: 'square' };
  }
  // 'bar' — random orientation, fall back to the other if the first fails.
  const tryH = (): PlacedCluster | null => {
    if (!inBounds(row, col + 1)) return null;
    const tiles = [anchor, tileAt(row, col + 1)];
    return tryLayout(tiles) ? { tiles, shape: 'bar-h' } : null;
  };
  const tryV = (): PlacedCluster | null => {
    if (!inBounds(row + 1, col)) return null;
    const tiles = [anchor, tileAt(row + 1, col)];
    return tryLayout(tiles) ? { tiles, shape: 'bar-v' } : null;
  };
  const horizontalFirst = rng() < 0.5;
  return (
    (horizontalFirst ? tryH() : tryV()) ??
    (horizontalFirst ? tryV() : tryH())
  );
}

/**
 * V6.5 — Pick a reachable, cluster-friendly placement. Repeats the
 * `pickReachableTile` + `expandClusterFromAnchor` attempt up to
 * `maxAttempts` times, marking exhausted anchors so it doesn't retry
 * the same dead spot. After exhaustion falls back to a single-tile
 * placement at the closest available anchor (so the player gets *a*
 * mole even if the shape couldn't fit).
 *
 * Returns null only when the zone has zero free tiles.
 */
export function pickReachableCluster(
  gs: GameState,
  zoneId: string,
  anchor: number | null,
  ttl: number,
  physical: PhysicalConfig,
  grid: { rows: number; cols: number },
  shape: ClusterShape,
  maxAttempts = 16,
): PlacedCluster | null {
  if (shape === 'single') {
    const tile = pickReachableTile(gs, zoneId, anchor, ttl, physical, grid.cols);
    return tile == null ? null : { tiles: [tile], shape: 'single' };
  }
  const blocklist = new Set<number>();
  const occupied = (idx: number): boolean => idx in gs.activeSpawns;
  for (let i = 0; i < maxAttempts; i++) {
    // Reuse the per-tile picker but exclude already-failed anchors so
    // the retry loop doesn't keep re-picking the same dead corner.
    const free = (gs.zones[zoneId] ?? []).filter(
      (t) => !(t in gs.activeSpawns) && !blocklist.has(t),
    );
    if (free.length === 0) break;
    // Inline a mini pickReachableTile against the filtered candidate list:
    let candidate: number | null;
    if (ttl <= 0 || anchor == null) {
      candidate = free[Math.floor(gs.rng() * free.length)]!;
    } else {
      const radius = reachRadius(ttl, physical);
      if (radius <= 0) {
        candidate = free[Math.floor(gs.rng() * free.length)]!;
      } else {
        const reachable: number[] = [];
        let closest: number | null = null;
        let closestDist = Infinity;
        for (const tile of free) {
          const d = tileDistanceChebyshev(tile, anchor, grid.cols);
          if (d <= radius) reachable.push(tile);
          else if (d < closestDist) {
            closestDist = d;
            closest = tile;
          }
        }
        candidate = reachable.length > 0
          ? reachable[Math.floor(gs.rng() * reachable.length)]!
          : closest;
      }
    }
    if (candidate == null) break;
    const cluster = expandClusterFromAnchor(candidate, shape, grid, occupied, gs.rng);
    if (cluster) return cluster;
    blocklist.add(candidate);
  }
  // Last-resort fallback: place a single tile rather than spawn nothing.
  const tile = pickReachableTile(gs, zoneId, anchor, ttl, physical, grid.cols);
  return tile == null ? null : { tiles: [tile], shape: 'single' };
}
