import { BLACK, clampByte, type RGB } from '@/utils/color.js';
import { logger } from '@/utils/logger.js';
import type { ITileDriver, SensorEventCallback, TileUpdate } from './driver.interface.js';

export interface MokaDriverOptions {
  serialPort: string;
  baudRate?: number;
  tileCount: number;
}

// Protocol command bytes
const CMD_FULL_FRAME = 0xaa;
const CMD_SINGLE_TILE = 0xbb;
const CMD_SENSOR_EVENT = 0xcc;

const SENSOR_PACKET_LEN = 5;

/**
 * Driver for Moka LED floor tiles over RS-485 serial.
 *
 * SKELETON IMPLEMENTATION — packet framing is fully wired but the actual
 * serial port read/write is stubbed (no-op writes, no real port opened).
 * The serialport import is intentionally lazy so the module can be imported
 * on systems without USB hardware.
 */
export class MokaDriver implements ITileDriver {
  private readonly portPath: string;
  private readonly baudRate: number;
  private readonly tileCount: number;
  private readonly tileColors: RGB[];

  private connected = false;
  private sensorCallback: SensorEventCallback | null = null;
  private port: unknown = null; // SerialPort instance once wired up
  private rxBuffer: Buffer = Buffer.alloc(0);
  private lastTx: Buffer | null = null;

  constructor(options: MokaDriverOptions) {
    this.portPath = options.serialPort;
    this.baudRate = options.baudRate ?? 115200;
    this.tileCount = options.tileCount;
    this.tileColors = Array.from({ length: this.tileCount }, () => ({ ...BLACK }));
  }

  async connect(): Promise<void> {
    logger.info(
      { port: this.portPath, baud: this.baudRate, tiles: this.tileCount },
      'connecting to Moka tiles (skeleton mode — serial writes are no-ops)',
    );
    // Real wire-up (deferred until hardware capture is complete):
    //   const { SerialPort } = await import('serialport');
    //   this.port = new SerialPort({ path: this.portPath, baudRate: this.baudRate });
    //   this.port.on('data', (chunk: Buffer) => this.onSerialData(chunk));
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.port = null;
    this.connected = false;
    this.rxBuffer = Buffer.alloc(0);
    logger.info('Moka driver disconnected');
  }

  setTileColor(tileIndex: number, r: number, g: number, b: number): void {
    if (tileIndex < 0 || tileIndex >= this.tileCount) return;
    const color: RGB = { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
    this.tileColors[tileIndex] = color;
    this.writeSerial(this.encodeSingleTile(tileIndex, color));
  }

  setAllTiles(colors: RGB[]): void {
    const n = Math.min(colors.length, this.tileCount);
    for (let i = 0; i < n; i++) {
      const c = colors[i];
      if (c) this.tileColors[i] = { r: clampByte(c.r), g: clampByte(c.g), b: clampByte(c.b) };
    }
    this.writeSerial(this.encodeFullFrame());
  }

  setBatchTiles(updates: TileUpdate[]): void {
    for (const u of updates) {
      if (u.index < 0 || u.index >= this.tileCount) continue;
      this.tileColors[u.index] = { r: clampByte(u.r), g: clampByte(u.g), b: clampByte(u.b) };
    }
    // Heuristic: large batches go as one full frame to avoid bus saturation.
    if (updates.length > this.tileCount * 0.5) {
      this.writeSerial(this.encodeFullFrame());
      return;
    }
    for (const u of updates) {
      if (u.index < 0 || u.index >= this.tileCount) continue;
      const color = this.tileColors[u.index] ?? BLACK;
      this.writeSerial(this.encodeSingleTile(u.index, color));
    }
  }

  onSensorEvent(callback: SensorEventCallback): void {
    this.sensorCallback = callback;
  }

  getTileCount(): number {
    return this.tileCount;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Serial protocol — exported via package-private methods for tests
  // ────────────────────────────────────────────────────────────────────────

  /** Encode a single-tile color update: 0xBB <hi> <lo> <r> <g> <b> <chk>. */
  encodeSingleTile(index: number, color: RGB): Buffer {
    const buf = Buffer.alloc(7);
    buf[0] = CMD_SINGLE_TILE;
    buf[1] = (index >> 8) & 0xff;
    buf[2] = index & 0xff;
    buf[3] = color.r & 0xff;
    buf[4] = color.g & 0xff;
    buf[5] = color.b & 0xff;
    buf[6] = this.checksum(buf.subarray(0, 6));
    return buf;
  }

  /** Encode a full-frame color update: 0xAA <count_hi> <count_lo> <RGB...> <chk>. */
  encodeFullFrame(): Buffer {
    const header = 3;
    const data = this.tileCount * 3;
    const buf = Buffer.alloc(header + data + 1);
    buf[0] = CMD_FULL_FRAME;
    buf[1] = (this.tileCount >> 8) & 0xff;
    buf[2] = this.tileCount & 0xff;
    for (let i = 0; i < this.tileCount; i++) {
      const c = this.tileColors[i] ?? BLACK;
      const off = header + i * 3;
      buf[off] = c.r & 0xff;
      buf[off + 1] = c.g & 0xff;
      buf[off + 2] = c.b & 0xff;
    }
    buf[buf.length - 1] = this.checksum(buf.subarray(0, buf.length - 1));
    return buf;
  }

  /** Feed raw bytes into the RX buffer — used by both serial and tests. */
  feedRx(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    this.parseRxBuffer();
  }

  /** Last buffer sent to writeSerial (skeleton helper for tests). */
  getLastTx(): Buffer | null {
    return this.lastTx;
  }

  /** Snapshot of current tile colors (test helper). */
  getTileColor(index: number): RGB {
    return { ...(this.tileColors[index] ?? BLACK) };
  }

  private writeSerial(data: Buffer): void {
    this.lastTx = data;
    if (!this.port) return;
    // Real wire-up:
    //   (this.port as SerialPort).write(data);
  }

  private parseRxBuffer(): void {
    while (this.rxBuffer.length >= SENSOR_PACKET_LEN) {
      if (this.rxBuffer[0] !== CMD_SENSOR_EVENT) {
        // Resync: drop one byte and try again.
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      const hi = this.rxBuffer[1] ?? 0;
      const lo = this.rxBuffer[2] ?? 0;
      const pressedByte = this.rxBuffer[3] ?? 0;
      const got = this.rxBuffer[4] ?? 0;

      const expected = this.checksum(this.rxBuffer.subarray(0, 4));
      if (got !== expected) {
        logger.warn({ expected, got }, 'Moka sensor checksum mismatch — dropping byte');
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      const tileIndex = (hi << 8) | lo;
      const pressed = pressedByte === 0x01;
      this.rxBuffer = this.rxBuffer.subarray(SENSOR_PACKET_LEN);

      if (tileIndex >= 0 && tileIndex < this.tileCount && this.sensorCallback) {
        this.sensorCallback(tileIndex, pressed);
      }
    }
  }

  private checksum(data: Buffer): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum = (sum + (data[i] ?? 0)) & 0xff;
    }
    return sum;
  }
}
