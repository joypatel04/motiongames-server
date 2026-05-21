export { GameInterpreter } from './interpreter.js';
export { makeInitialGameState } from './trigger-evaluator.js';
export type { GameState, TargetCluster } from './trigger-evaluator.js';
export type { StateChange } from './action-executor.js';
export type { GameDefinition } from './types/game-definition.js';
export { resolveZoneTiles } from './zone-resolver.js';
export { DEFAULT_TILE_COLOR, hexToRgb } from './color-hex.js';
