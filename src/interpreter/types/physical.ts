/**
 * V6.4 — Physical model for the LED floor arena.
 *
 * Game design needs a notion of "is this humanly playable?" — at high
 * difficulty, an unreachable spawn isn't hard, it's broken. The numbers
 * below convert game-time TTL into a *reachable* radius in floor tiles
 * so the engine can place spawns a real human can actually get to.
 *
 * # Audience
 *
 * Arena games target **Indian players, kids (~8 y) through seniors
 * (60+)**. The defaults below are inclusive — NOT athletic-adult values.
 * Difficulty should climb through cognitive load (more moles, more
 * distractors, faster scoring) rather than by prescribing movement a
 * 9-year-old or a 55-year-old physically can't make.
 *
 * See `docs/game-design-philosophy.md` for the full rationale.
 */

export interface PhysicalConfig {
  /** Width/height of one floor tile in metres. */
  tileMeters: number;
  /** Player movement speed in m/s under game conditions (brisk step, not run). */
  playerSpeed: number;
  /** Simple visual reaction time (perceive colour → start moving) in seconds. */
  reactionTime: number;
}

/**
 * Inclusive defaults for the target audience. Override at the game level
 * via `GameDefinition.physical` only when a specific variant intentionally
 * targets a narrower audience (e.g. a corporate-team-building variant for
 * adults can raise `playerSpeed` to 2.2 m/s).
 */
export const DEFAULT_PHYSICAL: PhysicalConfig = {
  tileMeters: 0.3,
  playerSpeed: 1.7,
  reactionTime: 0.7,
};

/**
 * Resolve the physical config for a definition. Missing fields fall back
 * to `DEFAULT_PHYSICAL`. Reads only the `physical` property so this works
 * for any definition-shaped object (resolved variants, mocks, etc.).
 */
export function effectivePhysical(
  def: { physical?: Partial<PhysicalConfig> } | null | undefined,
): PhysicalConfig {
  const o = def?.physical ?? {};
  return {
    tileMeters: typeof o.tileMeters === 'number' && o.tileMeters > 0
      ? o.tileMeters
      : DEFAULT_PHYSICAL.tileMeters,
    playerSpeed: typeof o.playerSpeed === 'number' && o.playerSpeed > 0
      ? o.playerSpeed
      : DEFAULT_PHYSICAL.playerSpeed,
    reactionTime: typeof o.reactionTime === 'number' && o.reactionTime >= 0
      ? o.reactionTime
      : DEFAULT_PHYSICAL.reactionTime,
  };
}

/**
 * Tiles the player can travel within `ttlSeconds`. Subtracts the reaction
 * window first (you can't move during the perceive→decide phase), then
 * converts the remaining movement budget through `playerSpeed / tileMeters`.
 *
 * Floors at 1 tile — even Master tier always lets you tap your own square.
 *
 * Returns 0 when `ttlSeconds <= 0` so callers can detect "no TTL ⇒ no
 * time pressure ⇒ disable the constraint."
 */
export function reachRadius(ttlSeconds: number, p: PhysicalConfig): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return 0;
  const usable = ttlSeconds - p.reactionTime;
  if (usable <= 0) return 1;
  const metres = usable * p.playerSpeed;
  const tiles = Math.floor(metres / p.tileMeters);
  return Math.max(1, tiles);
}

/**
 * Chebyshev (king-moves) distance between two tile indices on a grid of
 * `cols` columns. Models 8-directional stepping at uniform cost, matching
 * the arena's sensor topology where a diagonal step takes the same time
 * as an axial one.
 */
export function tileDistanceChebyshev(a: number, b: number, cols: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || cols <= 0) return Infinity;
  const ra = Math.floor(a / cols);
  const ca = a % cols;
  const rb = Math.floor(b / cols);
  const cb = b % cols;
  return Math.max(Math.abs(ra - rb), Math.abs(ca - cb));
}
