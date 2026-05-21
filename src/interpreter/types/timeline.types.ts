import type { Action, TriggerCondition } from './trigger.types';

export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'step';
export type TrackType =
  | 'tile'
  | 'logic'
  | 'audio'
  | 'wall_button'
  | 'display_widget'
  // V4 — short aliases used by the surface-grouped timeline UI
  | 'widget'
  | 'button';
export type TrackSurfaceKind = 'floor' | 'wall_buttons' | 'wall_display';
export type Pattern = 'solid' | 'blink' | 'pulse' | 'rainbow' | 'chase';
export type Direction = 'up' | 'down' | 'left' | 'right' | 'clockwise' | 'random';

export interface TileKeyframeState {
  color?: string;
  brightness?: number;
  pattern?: Pattern;
  patternSpeed?: number;
  direction?: Direction;
}

export interface LogicKeyframe {
  action: Action;
  condition?: TriggerCondition;
}

/** V4 — widget tracks animate a widget's value/color/visibility. */
export interface WidgetKeyframeState {
  widgetId: string;
  property: 'value' | 'color' | 'visible' | 'flashColor';
  targetValue: string | number | boolean;
}

/** V4 — button tracks animate wall button LEDs. */
export interface ButtonKeyframeState {
  buttonId: string;
  color: string;
  brightness: number;
  pattern: 'solid' | 'blink' | 'pulse';
  patternSpeed: number;
}

export interface Keyframe {
  id: string;
  time: number;
  duration: number;
  tileState?: TileKeyframeState;
  logic?: LogicKeyframe;
  widgetState?: WidgetKeyframeState;
  buttonState?: ButtonKeyframeState;
  easing: Easing;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  target?: string;
  keyframes: Keyframe[];
  /** V3 — which surface kind this track targets (floor by default). */
  surface?: TrackSurfaceKind;
  /** V3 — specific surface id for cross-surface games with multiple surfaces. */
  surfaceId?: string;
}

export interface TimelinePhase {
  id: string;
  name: string;
  duration: number;
  loop: boolean;
  loopCount?: number;
  endCondition?: TriggerCondition;
  tracks: Track[];
}
