import { BLACK, type RGB } from '@/utils/color.js';
import type { ITileDriver, SensorEventCallback, TileUpdate } from './driver.interface.js';

export interface MockDriverOptions {
  tileCount: number;
  sensorEventRateHz?: number; // average events per second; 0 disables auto-firing
  rng?: () => number;
}

/**
 * In-memory tile driver for development & tests. Deterministic when seeded.
 */
export class MockDriver implements ITileDriver {
  private readonly tileCount: number;
  private readonly tiles: RGB[];
  private readonly rng: () => number;
  private readonly sensorEventRateHz: number;
  private callbacks: SensorEventCallback[] = [];
  private autoFireTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private readonly pressed: boolean[];

  constructor(options: MockDriverOptions) {
    this.tileCount = options.tileCount;
    this.tiles = Array.from({ length: this.tileCount }, () => ({ ...BLACK }));
    this.pressed = Array.from({ length: this.tileCount }, () => false);
    this.rng = options.rng ?? Math.random;
    this.sensorEventRateHz = options.sensorEventRateHz ?? 0;
  }

  async connect(): Promise<void> {
    this.connected = true;
    if (this.sensorEventRateHz > 0) {
      const intervalMs = Math.max(1, Math.round(1000 / this.sensorEventRateHz));
      this.autoFireTimer = setInterval(() => this.fireRandomEvent(), intervalMs);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.autoFireTimer !== null) {
      clearInterval(this.autoFireTimer);
      this.autoFireTimer = null;
    }
  }

  setTileColor(tileIndex: number, r: number, g: number, b: number): void {
    if (tileIndex < 0 || tileIndex >= this.tileCount) return;
    this.tiles[tileIndex] = { r, g, b };
  }

  setAllTiles(colors: RGB[]): void {
    const n = Math.min(colors.length, this.tileCount);
    for (let i = 0; i < n; i++) {
      const c = colors[i];
      if (c) this.tiles[i] = { r: c.r, g: c.g, b: c.b };
    }
  }

  setBatchTiles(updates: TileUpdate[]): void {
    for (const u of updates) {
      this.setTileColor(u.index, u.r, u.g, u.b);
    }
  }

  onSensorEvent(callback: SensorEventCallback): void {
    this.callbacks.push(callback);
  }

  getTileCount(): number {
    return this.tileCount;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Test helpers

  /** Get a snapshot of current tile colors. */
  getTiles(): RGB[] {
    return this.tiles.map((c) => ({ ...c }));
  }

  /** Get color of a single tile. */
  getTileColor(index: number): RGB {
    return { ...(this.tiles[index] ?? BLACK) };
  }

  /** Manually trigger a sensor event (for tests). */
  pressTile(tileIndex: number): void {
    if (tileIndex < 0 || tileIndex >= this.tileCount) return;
    this.pressed[tileIndex] = true;
    this.emit(tileIndex, true);
  }

  releaseTile(tileIndex: number): void {
    if (tileIndex < 0 || tileIndex >= this.tileCount) return;
    this.pressed[tileIndex] = false;
    this.emit(tileIndex, false);
  }

  isPressed(tileIndex: number): boolean {
    return this.pressed[tileIndex] ?? false;
  }

  private fireRandomEvent(): void {
    const idx = Math.floor(this.rng() * this.tileCount);
    const wasPressed = this.pressed[idx] ?? false;
    if (wasPressed) this.releaseTile(idx);
    else this.pressTile(idx);
  }

  private emit(tileIndex: number, pressed: boolean): void {
    for (const cb of this.callbacks) {
      cb(tileIndex, pressed);
    }
  }
}
