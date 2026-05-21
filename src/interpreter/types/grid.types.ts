export interface TileState {
  index: number;
  row: number;
  col: number;
  color: string;
  brightness: number;
  zoneId?: string;
}

export interface GridConfig {
  rows: number;
  cols: number;
}

export type ZoneSelectorType =
  | 'all'
  | 'border'
  | 'center'
  | 'rows'
  | 'cols'
  | 'corners'
  | 'random_percent'
  | 'quadrant'
  | 'stripe'
  | 'ring'
  | 'path'
  | 'custom_expr';

/**
 * V3 — selectors that resolve against a wall_buttons surface. Kept as a
 * separate union so floor zone editors don't have to render wall-button
 * params and vice versa.
 */
export type ButtonZoneSelectorType =
  | 'all_buttons'
  | 'wall_buttons'
  | 'height_buttons'
  | 'button_range';

export interface ButtonZoneSelector {
  type: ButtonZoneSelectorType;
  params: Record<string, unknown>;
}

export interface ZoneSelector {
  type: ZoneSelectorType;
  params: Record<string, unknown>;
}

export interface Zone {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  /**
   * V1 absolute tile indices. Optional in V2 — when a selector is present,
   * tiles is the resolved cache for the current grid size and is recomputed
   * automatically. When no selector is set, tiles is the source of truth.
   */
  tiles: number[];
  /**
   * V2 grid-adaptive zone selector. When present, the zone's membership is
   * computed from this selector against the current grid.
   */
  selector?: ZoneSelector;
  color: string;
  properties: Record<string, unknown>;
  /**
   * V3 — which surface this zone belongs to. Floor zones reference the
   * floor surface; button zones reference a wall_buttons surface. When
   * omitted, the zone targets the primary floor surface (V1/V2 behaviour).
   */
  surfaceId?: string;
  /**
   * V3 — for wall-button zones, the resolved cache of button ids that
   * match the selector. Floor zones leave this empty and use `tiles`.
   */
  buttonIds?: string[];
  /**
   * V3 — wall-button selector. Mutually exclusive with `selector` (which is
   * a floor selector). When present, surfaceId must reference a
   * wall_buttons surface.
   */
  buttonSelector?: ButtonZoneSelector;
}
