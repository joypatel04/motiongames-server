# Ralph Loop — Score Sync Pipeline + Moka Driver Skeleton

> **Linear:** STR-16 + STR-17 | **Repo:** arena-server | **Day 9–10**
> **When done, update Linear:** mark STR-16 and STR-17 as Done

## Goal

1. **Score sync pipeline** — After a game session completes, sync scores and
   session data from local SQLite to Supabase cloud. This enables leaderboards
   and analytics across all arena installations.
2. **Moka driver skeleton** — Create the serial driver that will talk to real
   Moka LED tiles. For now it's a skeleton with the serial protocol structure,
   testable without hardware.

## Important context

- Read `CLAUDE.md` for project conventions.
- The Supabase project ID is `agqnqwispnaytefftgpe`.
- The server already has a `sync_queue` table in SQLite (from `001_initial.sql`)
  and a `SyncQueueRepository` that enqueues records when sessions are finalized
  (see `session-manager.ts` `finalize()` method).
- `@supabase/supabase-js` and `serialport` are already in `package.json`.
- The `CatalogSync` service from RALPH_LIVE_PIPELINE already sets up the
  Supabase client.

## Task 1: Score sync pipeline (STR-16)

### Current state

The `SessionManager.finalize()` method already enqueues to `sync_queue`:

```typescript
this.syncQueue.enqueue({
  tableName: 'arena_sessions',
  operation: 'UPDATE',
  payload: { id: sessionId, status: 'completed', duration_seconds: duration },
});
for (const s of ranked) {
  this.syncQueue.enqueue({
    tableName: 'arena_scores',
    operation: 'INSERT',
    payload: { ... },
  });
}
```

What's missing: a service that drains `sync_queue` and pushes to Supabase.

### Create `src/services/score-sync.ts`

```typescript
import { getSupabaseClient } from './supabase-client.js';
import type { SyncQueueRepository, SyncQueueRow } from '@/db/repositories/sync-queue.repo.js';
import pino from 'pino';

const logger = pino({ name: 'score-sync' });

export interface ScoreSyncOptions {
  syncQueue: SyncQueueRepository;
  intervalMs?: number; // default 10_000 (10 seconds)
  batchSize?: number;  // default 50
}

export class ScoreSync {
  private readonly syncQueue: SyncQueueRepository;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScoreSyncOptions) {
    this.syncQueue = options.syncQueue;
    this.intervalMs = options.intervalMs ?? 10_000;
    this.batchSize = options.batchSize ?? 50;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch((err) => logger.error({ err }, 'Score sync failed'));
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Score sync started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush(): Promise<number> {
    const supabase = getSupabaseClient();
    if (!supabase) return 0;

    const pending = this.syncQueue.getPending(this.batchSize);
    if (pending.length === 0) return 0;

    let synced = 0;
    for (const row of pending) {
      try {
        await this.syncRow(row, supabase);
        this.syncQueue.markSynced(row.id);
        synced++;
      } catch (err) {
        logger.error({ err, rowId: row.id, table: row.table_name }, 'Failed to sync row');
        // Leave unsynced — will retry next flush
      }
    }

    if (synced > 0) {
      logger.info({ synced, total: pending.length }, 'Score sync flushed');
    }
    return synced;
  }

  private async syncRow(row: SyncQueueRow, supabase: any): Promise<void> {
    const payload = JSON.parse(row.payload);

    // Map local table names to Supabase tables
    // Local SQLite uses the same table names as Supabase for sessions/scores
    // but we need to handle the difference in schema

    switch (row.table_name) {
      case 'arena_sessions': {
        if (row.operation === 'INSERT') {
          await supabase.from('arena_sessions_cloud').upsert(payload);
        } else if (row.operation === 'UPDATE') {
          const { id, ...updates } = payload;
          await supabase.from('arena_sessions_cloud').update(updates).eq('id', id);
        }
        break;
      }
      case 'arena_scores': {
        await supabase.from('arena_scores_cloud').upsert(payload);
        break;
      }
      default:
        logger.warn({ table: row.table_name }, 'Unknown table in sync queue');
    }
  }
}
```

**Note:** The Supabase cloud tables for sessions and scores may not exist yet,
or may have different names than the local SQLite ones. Adjust the table names
above (`arena_sessions_cloud`, `arena_scores_cloud`) to match whatever Supabase
tables Joy has set up for this. If they don't exist yet, create them:

### Supabase tables for session/score sync (if needed)

These should be created via Supabase SQL editor or a migration. The schema
should match what the sync queue pushes:

```sql
-- Only create these if they don't already exist in Supabase
CREATE TABLE IF NOT EXISTS arena_sessions_cloud (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arena_id TEXT,          -- identifies which physical arena
  game_slug TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  player_count INTEGER DEFAULT 1,
  difficulty TEXT DEFAULT 'medium',
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arena_scores_cloud (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES arena_sessions_cloud(id),
  display_name TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  rank INTEGER,
  is_winner BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE arena_sessions_cloud ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena_scores_cloud ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY sessions_service ON arena_sessions_cloud FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY scores_service ON arena_scores_cloud FOR ALL USING (true) WITH CHECK (true);
```

### Wire into server bootstrap

```typescript
import { ScoreSync } from '@/services/score-sync.js';

const scoreSync = new ScoreSync({ syncQueue: syncQueueRepo });
scoreSync.start();

// On shutdown:
scoreSync.stop();
```

## Task 2: Moka driver skeleton (STR-17)

### Hardware context

Moka LED floor tiles:
- Daisy-chained via RS-485 serial (USB adapter to RPi)
- Each tile has RGB LEDs and a pressure sensor
- Communication is half-duplex: host sends color commands, tiles send back
  sensor events
- 192 tiles in a 16×12 grid

### Serial protocol (based on Moka documentation)

**This is a BEST GUESS based on common LED tile protocols. Adjust when actual
Moka docs are available.**

```
Color command (host → tiles):
  [0xAA] [tile_count_hi] [tile_count_lo] [r0] [g0] [b0] [r1] [g1] [b1] ... [checksum]

Single tile command:
  [0xBB] [tile_index_hi] [tile_index_lo] [r] [g] [b] [checksum]

Sensor event (tiles → host):
  [0xCC] [tile_index_hi] [tile_index_lo] [pressed: 0x01/0x00] [checksum]
```

### Create `src/drivers/moka-driver.ts`

```typescript
import type { ITileDriver, TileUpdate, SensorEventCallback } from './driver.interface.js';
import type { RGB } from '@/utils/color.js';
import pino from 'pino';

const logger = pino({ name: 'moka-driver' });

export interface MokaDriverOptions {
  serialPort: string;  // e.g., '/dev/ttyUSB0' or 'COM3'
  baudRate?: number;    // default 115200
  tileCount: number;    // total tiles (e.g., 192)
}

/**
 * Driver for Moka LED floor tiles over serial.
 *
 * SKELETON IMPLEMENTATION — serial communication is stubbed.
 * Replace the serial read/write with actual serialport calls when hardware
 * is available.
 */
export class MokaDriver implements ITileDriver {
  private readonly portPath: string;
  private readonly baudRate: number;
  private readonly tileCount: number;
  private connected = false;
  private sensorCallback: SensorEventCallback | null = null;
  private port: any = null; // Will be SerialPort instance

  // Buffer for incoming sensor data
  private rxBuffer: Buffer = Buffer.alloc(0);

  // Track current tile colors for full-frame sends
  private tileColors: RGB[];

  constructor(options: MokaDriverOptions) {
    this.portPath = options.serialPort;
    this.baudRate = options.baudRate ?? 115200;
    this.tileCount = options.tileCount;
    this.tileColors = Array.from({ length: this.tileCount }, () => ({ r: 0, g: 0, b: 0 }));
  }

  async connect(): Promise<void> {
    logger.info({ port: this.portPath, baud: this.baudRate }, 'Connecting to Moka tiles');

    // TODO: Uncomment when hardware is available
    // const { SerialPort } = await import('serialport');
    // this.port = new SerialPort({
    //   path: this.portPath,
    //   baudRate: this.baudRate,
    // });
    //
    // this.port.on('data', (chunk: Buffer) => this.onSerialData(chunk));
    // this.port.on('error', (err: Error) => logger.error({ err }, 'Serial error'));
    //
    // await new Promise<void>((resolve, reject) => {
    //   this.port.on('open', () => {
    //     logger.info('Serial port opened');
    //     resolve();
    //   });
    //   this.port.on('error', reject);
    // });

    this.connected = true;
    logger.info('Moka driver connected (skeleton mode — no hardware)');
  }

  async disconnect(): Promise<void> {
    if (this.port) {
      // this.port.close();
      this.port = null;
    }
    this.connected = false;
    logger.info('Moka driver disconnected');
  }

  setTileColor(tileIndex: number, r: number, g: number, b: number): void {
    if (tileIndex < 0 || tileIndex >= this.tileCount) return;
    this.tileColors[tileIndex] = { r, g, b };
    this.sendSingleTile(tileIndex, r, g, b);
  }

  setAllTiles(colors: RGB[]): void {
    for (let i = 0; i < Math.min(colors.length, this.tileCount); i++) {
      this.tileColors[i] = colors[i];
    }
    this.sendFullFrame();
  }

  setBatchTiles(updates: TileUpdate[]): void {
    for (const u of updates) {
      if (u.index >= 0 && u.index < this.tileCount) {
        this.tileColors[u.index] = { r: u.r, g: u.g, b: u.b };
      }
    }

    // For small batches, send individual tile commands
    // For large batches (>50% of tiles), send a full frame
    if (updates.length > this.tileCount * 0.5) {
      this.sendFullFrame();
    } else {
      for (const u of updates) {
        this.sendSingleTile(u.index, u.r, u.g, u.b);
      }
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

  // --- Serial protocol ---

  private sendSingleTile(index: number, r: number, g: number, b: number): void {
    const buf = Buffer.alloc(7);
    buf[0] = 0xBB; // single tile command
    buf[1] = (index >> 8) & 0xFF;
    buf[2] = index & 0xFF;
    buf[3] = r & 0xFF;
    buf[4] = g & 0xFF;
    buf[5] = b & 0xFF;
    buf[6] = this.checksum(buf.subarray(0, 6));
    this.writeSerial(buf);
  }

  private sendFullFrame(): void {
    const headerSize = 3;
    const dataSize = this.tileCount * 3;
    const buf = Buffer.alloc(headerSize + dataSize + 1);

    buf[0] = 0xAA; // full frame command
    buf[1] = (this.tileCount >> 8) & 0xFF;
    buf[2] = this.tileCount & 0xFF;

    for (let i = 0; i < this.tileCount; i++) {
      const offset = headerSize + i * 3;
      buf[offset] = this.tileColors[i].r & 0xFF;
      buf[offset + 1] = this.tileColors[i].g & 0xFF;
      buf[offset + 2] = this.tileColors[i].b & 0xFF;
    }

    buf[buf.length - 1] = this.checksum(buf.subarray(0, buf.length - 1));
    this.writeSerial(buf);
  }

  private writeSerial(data: Buffer): void {
    if (!this.port) return;
    // this.port.write(data);
  }

  private onSerialData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    this.parseRxBuffer();
  }

  private parseRxBuffer(): void {
    // Look for sensor event packets: [0xCC] [hi] [lo] [pressed] [checksum]
    while (this.rxBuffer.length >= 5) {
      if (this.rxBuffer[0] !== 0xCC) {
        // Skip unknown byte
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      const tileIndex = (this.rxBuffer[1] << 8) | this.rxBuffer[2];
      const pressed = this.rxBuffer[3] === 0x01;
      const expected = this.checksum(this.rxBuffer.subarray(0, 4));

      if (this.rxBuffer[4] !== expected) {
        logger.warn({ expected, got: this.rxBuffer[4] }, 'Checksum mismatch');
        this.rxBuffer = this.rxBuffer.subarray(1);
        continue;
      }

      // Valid sensor event
      this.rxBuffer = this.rxBuffer.subarray(5);

      if (this.sensorCallback && tileIndex < this.tileCount) {
        this.sensorCallback(tileIndex, pressed);
      }
    }
  }

  private checksum(data: Buffer): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum = (sum + data[i]) & 0xFF;
    }
    return sum;
  }
}
```

### Add driver selection in server config

Update the server bootstrap to select driver based on environment:

```typescript
import { MokaDriver } from '@/drivers/moka-driver.js';
import { MockDriver } from '@/drivers/mock-driver.js';

function createDriver(): ITileDriver {
  const driverType = process.env.TILE_DRIVER ?? 'mock';

  switch (driverType) {
    case 'moka':
      return new MokaDriver({
        serialPort: process.env.MOKA_SERIAL_PORT ?? '/dev/ttyUSB0',
        baudRate: Number(process.env.MOKA_BAUD_RATE ?? 115200),
        tileCount: Number(process.env.TILE_COUNT ?? 192),
      });
    case 'mock':
    default:
      return new MockDriver(Number(process.env.TILE_COUNT ?? 192));
  }
}
```

### Add env vars

Update `.env.example`:
```
# Driver selection
TILE_DRIVER=mock          # mock | moka
TILE_COUNT=192

# Moka hardware (only when TILE_DRIVER=moka)
MOKA_SERIAL_PORT=/dev/ttyUSB0
MOKA_BAUD_RATE=115200

# Score sync
SCORE_SYNC_INTERVAL_MS=10000
```

### Write tests for MokaDriver

Create `tests/drivers/moka-driver.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MokaDriver } from '@/drivers/moka-driver.js';

describe('MokaDriver', () => {
  it('creates with correct tile count', () => {
    const driver = new MokaDriver({
      serialPort: '/dev/ttyUSB0',
      tileCount: 192,
    });
    expect(driver.getTileCount()).toBe(192);
    expect(driver.isConnected()).toBe(false);
  });

  it('connects in skeleton mode', async () => {
    const driver = new MokaDriver({
      serialPort: '/dev/ttyUSB0',
      tileCount: 192,
    });
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
  });

  it('tracks sensor callback', async () => {
    const driver = new MokaDriver({
      serialPort: '/dev/ttyUSB0',
      tileCount: 192,
    });
    const callback = vi.fn();
    driver.onSensorEvent(callback);
    // In skeleton mode, no serial data will arrive
    // This just verifies the callback is registered
  });

  it('handles setBatchTiles without error', async () => {
    const driver = new MokaDriver({
      serialPort: '/dev/ttyUSB0',
      tileCount: 192,
    });
    await driver.connect();
    driver.setBatchTiles([
      { index: 0, r: 255, g: 0, b: 0 },
      { index: 5, r: 0, g: 255, b: 0 },
    ]);
    // Should not throw in skeleton mode
  });

  it('disconnects cleanly', async () => {
    const driver = new MokaDriver({
      serialPort: '/dev/ttyUSB0',
      tileCount: 192,
    });
    await driver.connect();
    await driver.disconnect();
    expect(driver.isConnected()).toBe(false);
  });
});
```

## Testing

1. **Score sync:**
   - Start server with Supabase configured
   - Play a game session to completion
   - Check logs for "Score sync flushed"
   - Verify data in Supabase dashboard

2. **Moka driver:**
   - Set `TILE_DRIVER=moka` in `.env.local`
   - Start server → should see "Moka driver connected (skeleton mode)"
   - Play a game → no errors (serial writes are no-ops)
   - Set back to `TILE_DRIVER=mock`

```bash
bun run test         # all tests pass
bun run typecheck    # no new type errors
```

## After completion

Update Linear: mark STR-16 and STR-17 as Done.
