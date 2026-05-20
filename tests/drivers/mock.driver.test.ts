import { describe, it, expect } from 'vitest';
import { MockDriver } from '@/drivers/mock.driver.js';

describe('MockDriver', () => {
  it('initializes with given tile count, all tiles black', async () => {
    const d = new MockDriver({ tileCount: 10 });
    expect(d.getTileCount()).toBe(10);
    expect(d.isConnected()).toBe(false);
    await d.connect();
    expect(d.isConnected()).toBe(true);
    for (const c of d.getTiles()) {
      expect(c).toEqual({ r: 0, g: 0, b: 0 });
    }
    await d.disconnect();
    expect(d.isConnected()).toBe(false);
  });

  it('setTileColor updates a single tile', () => {
    const d = new MockDriver({ tileCount: 4 });
    d.setTileColor(2, 10, 20, 30);
    expect(d.getTileColor(2)).toEqual({ r: 10, g: 20, b: 30 });
    expect(d.getTileColor(0)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('setTileColor ignores out-of-bounds indices', () => {
    const d = new MockDriver({ tileCount: 4 });
    d.setTileColor(-1, 10, 20, 30);
    d.setTileColor(99, 10, 20, 30);
    for (const c of d.getTiles()) expect(c).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('setBatchTiles applies multiple updates', () => {
    const d = new MockDriver({ tileCount: 4 });
    d.setBatchTiles([
      { index: 0, r: 1, g: 2, b: 3 },
      { index: 3, r: 9, g: 8, b: 7 },
    ]);
    expect(d.getTileColor(0)).toEqual({ r: 1, g: 2, b: 3 });
    expect(d.getTileColor(3)).toEqual({ r: 9, g: 8, b: 7 });
  });

  it('setAllTiles applies an array of colors', () => {
    const d = new MockDriver({ tileCount: 3 });
    d.setAllTiles([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
    expect(d.getTiles()).toEqual([
      { r: 1, g: 0, b: 0 },
      { r: 0, g: 1, b: 0 },
      { r: 0, g: 0, b: 1 },
    ]);
  });

  it('emits sensor events to all registered callbacks', () => {
    const d = new MockDriver({ tileCount: 4 });
    const events: Array<[number, boolean]> = [];
    d.onSensorEvent((idx, pressed) => events.push([idx, pressed]));
    d.pressTile(2);
    d.releaseTile(2);
    expect(events).toEqual([
      [2, true],
      [2, false],
    ]);
  });

  it('is deterministic with a seeded RNG', async () => {
    let seed = 0;
    const rng = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const d = new MockDriver({ tileCount: 16, sensorEventRateHz: 0, rng });
    const events: number[] = [];
    d.onSensorEvent((idx) => events.push(idx));
    await d.connect();
    // Fire 5 manual random events through the same rng
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor(rng() * 16);
      d.pressTile(idx);
    }
    expect(events.length).toBe(5);
    await d.disconnect();
  });
});
