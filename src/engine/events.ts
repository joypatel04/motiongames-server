export interface GameEventMap {
  game_loaded: { gameId: string; players: number; difficulty: string };
  game_start: { gameId: string; sessionId?: string };
  game_pause: { gameId: string };
  game_resume: { gameId: string };
  game_end: { gameId: string; reason: 'finished' | 'stopped' | 'error' };
  score_update: { playerIndex: number; score: number; total: number };
  tile_pressed: { tileIndex: number };
  tile_released: { tileIndex: number };
  tick: { elapsedMs: number; remainingMs: number };
  error: { message: string };
}

export type GameEventType = keyof GameEventMap;
export type GameEventListener<T extends GameEventType> = (payload: GameEventMap[T]) => void;

export class GameEventEmitter {
  private listeners: { [K in GameEventType]?: Array<GameEventListener<K>> } = {};

  on<T extends GameEventType>(type: T, listener: GameEventListener<T>): () => void {
    const arr = (this.listeners[type] ?? []) as Array<GameEventListener<T>>;
    arr.push(listener);
    this.listeners[type] = arr as never;
    return () => this.off(type, listener);
  }

  off<T extends GameEventType>(type: T, listener: GameEventListener<T>): void {
    const arr = this.listeners[type] as Array<GameEventListener<T>> | undefined;
    if (!arr) return;
    const i = arr.indexOf(listener);
    if (i !== -1) arr.splice(i, 1);
  }

  emit<T extends GameEventType>(type: T, payload: GameEventMap[T]): void {
    const arr = this.listeners[type] as Array<GameEventListener<T>> | undefined;
    if (!arr) return;
    for (const cb of [...arr]) cb(payload);
  }

  removeAll(): void {
    this.listeners = {};
  }
}
