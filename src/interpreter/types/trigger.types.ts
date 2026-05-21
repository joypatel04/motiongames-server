export type ConditionType =
  | 'on_step'
  | 'on_release'
  | 'on_timer'
  | 'on_score'
  | 'on_zone_clear'
  | 'on_zone_enter'
  | 'on_spawn_collected'
  | 'on_all_targets_hit'
  | 'on_lives_zero'
  // V3 — wall-button conditions
  | 'on_button_hit'
  | 'on_button_release'
  | 'on_all_buttons_hit'
  // V3 — compound condition wrapper. When type is and/or/sequence,
  // `conditions` carries the sub-conditions.
  | 'and'
  | 'or'
  | 'sequence'
  | 'custom';

export type TriggerSurfaceKind = 'floor' | 'wall_buttons' | 'wall_display';

export interface TriggerCondition {
  type: ConditionType;
  /** V3 — which surface the condition references. */
  surface?: TriggerSurfaceKind;
  /** Surface id for cross-surface games with multiple of one kind. */
  surfaceId?: string;
  target?: string;
  value?: number;
  /** V3 — sub-conditions for compound types (and/or/sequence). */
  conditions?: TriggerCondition[];
  /** V3 — for `sequence`, max seconds allowed between consecutive steps. */
  timeout?: number;
}

export type ActionType =
  | 'score'
  | 'flash'
  | 'color_change'
  | 'spawn'
  | 'despawn'
  | 'move_zone'
  | 'expand_zone'
  | 'shrink_zone'
  | 'speed_change'
  | 'win'
  | 'lose'
  | 'sound'
  | 'next_phase'
  // V3 — wall display actions
  | 'update_widget'
  | 'flash_display'
  | 'show_message'
  | 'custom';

export interface Action {
  type: ActionType;
  params: Record<string, unknown>;
}

export interface Trigger {
  id: string;
  condition: TriggerCondition;
  action: Action;
  cooldown?: number;
  maxFires?: number;
}
