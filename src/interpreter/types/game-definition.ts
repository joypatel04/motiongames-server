import type { Zone } from './grid.types.js';
import type { Track, TimelinePhase } from './timeline.types.js';
import type { Trigger, TriggerCondition } from './trigger.types.js';
import type { PhysicalConfig } from './physical.js';

// ── Inlined from variables.types.ts ─────────────────────────────────
export interface GameVariable {
  default: number;
  min: number;
  max: number;
  unit: string;
  label: string;
}

export interface DifficultyPreset {
  label: string;
  overrides: Record<string, number>;
  durationMultiplier: number;
}

// ── Minimal stubs — interpreter reads these structurally, never calls methods ──
export interface Surface {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface DisplayWidget {
  id: string;
  type: string;
  surfaceId: string;
  position: { row: number; col: number };
  size: { width: number; height: number };
  widgetConfig: Record<string, unknown>;
  zIndex: number;
}

// ── Core game definition ────────────────────────────────────────────
export type ScoringType = 'points' | 'time' | 'survival' | 'distance' | 'custom';
export type DurationMode = 'fixed' | 'unlimited' | 'condition';
export type WinConditionType =
  | 'highest_score'
  | 'reach_score'
  | 'last_standing'
  | 'reach_zone'
  | 'time_survival'
  | 'custom';

export interface WinCondition {
  type: WinConditionType;
  value?: number;
  target?: string;
}

export interface DifficultyOverrides {
  speedMultiplier?: number;
  spawnRate?: number;
  zoneGrowthRate?: number;
  duration?: number;
  extraLives?: number;
  targetVisibleTime?: number;
}

export interface GameDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  grid: {
    rows: number;
    cols: number;
  };
  players: {
    min: number;
    max: number;
    colors: string[];
  };
  scoring: {
    type: ScoringType;
    initialScore: number;
    winCondition: WinCondition;
  };
  duration: {
    mode: DurationMode;
    seconds?: number;
    endCondition?: TriggerCondition;
  };
  difficulties: {
    easy: DifficultyOverrides;
    medium: DifficultyOverrides;
    hard: DifficultyOverrides;
  };
  zones: Zone[];
  timeline: {
    tracks: Track[];
    phases?: TimelinePhase[];
  };
  triggers: Trigger[];
  variables?: Record<string, GameVariable>;
  difficultyPresets?: Record<string, DifficultyPreset>;
  category?: string;
  tags?: string[];
  phases?: TimelinePhase[];
  gridDesignedOn?: { rows: number; cols: number };
  surfaces?: Surface[];
  displayWidgets?: DisplayWidget[];
  testedGrids?: string[];
  surfacesRequired?: string[];
  durationRules?: Record<string, Record<string, number>>;
  maxDuration?: number;
  physical?: Partial<PhysicalConfig>;
}
