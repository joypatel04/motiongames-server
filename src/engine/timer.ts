export type TimerState = 'idle' | 'running' | 'paused' | 'stopped';

export interface TimerOptions {
  durationMs: number;
  now?: () => number;
}

export class GameTimer {
  private readonly durationMs: number;
  private readonly now: () => number;
  private state: TimerState = 'idle';
  private startedAt = 0;
  private accumulated = 0;
  private pausedAt = 0;

  constructor(options: TimerOptions) {
    if (options.durationMs < 0) throw new Error('durationMs must be >= 0');
    this.durationMs = options.durationMs;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.state === 'running') return;
    this.state = 'running';
    this.startedAt = this.now();
    this.accumulated = 0;
    this.pausedAt = 0;
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.accumulated += this.now() - this.startedAt;
    this.pausedAt = this.now();
    this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.startedAt = this.now();
    this.state = 'running';
  }

  stop(): void {
    if (this.state === 'running') {
      this.accumulated += this.now() - this.startedAt;
    }
    this.state = 'stopped';
  }

  reset(): void {
    this.state = 'idle';
    this.startedAt = 0;
    this.accumulated = 0;
    this.pausedAt = 0;
  }

  elapsedMs(): number {
    if (this.state === 'running') {
      return this.accumulated + (this.now() - this.startedAt);
    }
    return this.accumulated;
  }

  remainingMs(): number {
    return Math.max(0, this.durationMs - this.elapsedMs());
  }

  isExpired(): boolean {
    return this.elapsedMs() >= this.durationMs;
  }

  getState(): TimerState {
    return this.state;
  }

  getDuration(): number {
    return this.durationMs;
  }
}
