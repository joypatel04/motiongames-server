import type {
  ITileDriver,
  SensorEventCallback,
  TileUpdate,
} from './driver.interface.js';
import type { RGB } from '@/utils/color.js';
import type { ArenaWsServer } from '@/server/ws-server.js';

/**
 * Wraps any ITileDriver to mirror tile writes onto a WebSocket fan-out so the
 * floor simulator (and future launcher) can render exactly what the engine is
 * pushing to hardware. Sensor events still flow through the inner driver.
 */
export class WsBroadcastDriver implements ITileDriver {
  private readonly inner: ITileDriver;
  private wsServer: ArenaWsServer | null = null;
  private elapsed = 0;
  private remaining = 0;

  constructor(inner: ITileDriver, wsServer?: ArenaWsServer) {
    this.inner = inner;
    if (wsServer) this.wsServer = wsServer;
  }

  /** Late-bind the WS fan-out; required because ws-server depends on engine. */
  attachWsServer(wsServer: ArenaWsServer): void {
    this.wsServer = wsServer;
  }

  /** Engine ticks call this to provide timing context for the next broadcast. */
  setTimingContext(elapsed: number, remaining: number): void {
    this.elapsed = elapsed;
    this.remaining = remaining;
  }

  connect(): Promise<void> {
    return this.inner.connect();
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  setTileColor(tileIndex: number, r: number, g: number, b: number): void {
    this.inner.setTileColor(tileIndex, r, g, b);
    this.wsServer?.sendTileUpdate(
      [{ index: tileIndex, r, g, b }],
      this.elapsed,
      this.remaining,
    );
  }

  setAllTiles(colors: RGB[]): void {
    this.inner.setAllTiles(colors);
    const tiles = colors.map((c, index) => ({ index, r: c.r, g: c.g, b: c.b }));
    this.wsServer?.sendTileUpdate(tiles, this.elapsed, this.remaining);
  }

  setBatchTiles(updates: TileUpdate[]): void {
    this.inner.setBatchTiles(updates);
    if (updates.length === 0) return;
    const tiles = updates.map((u) => ({ index: u.index, r: u.r, g: u.g, b: u.b }));
    this.wsServer?.sendTileUpdate(tiles, this.elapsed, this.remaining);
  }

  onSensorEvent(callback: SensorEventCallback): void {
    this.inner.onSensorEvent(callback);
  }

  getTileCount(): number {
    return this.inner.getTileCount();
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }
}
