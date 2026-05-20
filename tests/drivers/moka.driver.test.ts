import { describe, it, expect, vi } from 'vitest';
import { MokaDriver } from '@/drivers/moka.driver.js';

function makeDriver(tileCount = 16): MokaDriver {
  return new MokaDriver({ serialPort: '/dev/null-test', baudRate: 115200, tileCount });
}

describe('MokaDriver', () => {
  it('reports tile count and starts disconnected', () => {
    const driver = makeDriver(192);
    expect(driver.getTileCount()).toBe(192);
    expect(driver.isConnected()).toBe(false);
  });

  it('connects and disconnects in skeleton mode', async () => {
    const driver = makeDriver();
    await driver.connect();
    expect(driver.isConnected()).toBe(true);
    await driver.disconnect();
    expect(driver.isConnected()).toBe(false);
  });

  it('encodes a single-tile packet with correct framing and checksum', () => {
    const driver = makeDriver(192);
    const buf = driver.encodeSingleTile(5, { r: 10, g: 20, b: 30 });

    expect(buf.length).toBe(7);
    expect(buf[0]).toBe(0xbb);
    expect(buf[1]).toBe(0x00);
    expect(buf[2]).toBe(5);
    expect(buf[3]).toBe(10);
    expect(buf[4]).toBe(20);
    expect(buf[5]).toBe(30);
    expect(buf[6]).toBe((0xbb + 0 + 5 + 10 + 20 + 30) & 0xff);
  });

  it('encodes a full frame with the configured tile count', () => {
    const driver = makeDriver(4);
    driver.setAllTiles([
      { r: 1, g: 2, b: 3 },
      { r: 4, g: 5, b: 6 },
      { r: 7, g: 8, b: 9 },
      { r: 10, g: 11, b: 12 },
    ]);
    const buf = driver.encodeFullFrame();

    // header (3) + 4 tiles * 3 RGB + 1 checksum
    expect(buf.length).toBe(3 + 4 * 3 + 1);
    expect(buf[0]).toBe(0xaa);
    expect(buf[1]).toBe(0);
    expect(buf[2]).toBe(4);
    expect(buf[3]).toBe(1);
    expect(buf[14]).toBe(12);

    // Verify checksum is the sum-mod-256 of all preceding bytes
    let expected = 0;
    for (let i = 0; i < buf.length - 1; i++) expected = (expected + (buf[i] ?? 0)) & 0xff;
    expect(buf[buf.length - 1]).toBe(expected);
  });

  it('writes a tile via setTileColor (skeleton: stored, no throw)', async () => {
    const driver = makeDriver(16);
    await driver.connect();
    driver.setTileColor(3, 255, 128, 64);
    expect(driver.getTileColor(3)).toEqual({ r: 255, g: 128, b: 64 });

    const tx = driver.getLastTx();
    expect(tx).not.toBeNull();
    expect(tx?.[0]).toBe(0xbb);
    expect(tx?.[2]).toBe(3);
  });

  it('chooses a full frame when the batch exceeds half the grid', async () => {
    const driver = makeDriver(4);
    await driver.connect();
    driver.setBatchTiles([
      { index: 0, r: 1, g: 1, b: 1 },
      { index: 1, r: 2, g: 2, b: 2 },
      { index: 2, r: 3, g: 3, b: 3 },
    ]);
    expect(driver.getLastTx()?.[0]).toBe(0xaa);
  });

  it('uses single-tile writes when the batch is small', async () => {
    const driver = makeDriver(16);
    await driver.connect();
    driver.setBatchTiles([
      { index: 0, r: 1, g: 1, b: 1 },
      { index: 1, r: 2, g: 2, b: 2 },
    ]);
    expect(driver.getLastTx()?.[0]).toBe(0xbb);
  });

  it('parses a valid sensor packet and forwards a press event', () => {
    const driver = makeDriver(192);
    const cb = vi.fn();
    driver.onSensorEvent(cb);

    // Build a sensor event for tile index 42 (pressed)
    const idx = 42;
    const packet = Buffer.alloc(5);
    packet[0] = 0xcc;
    packet[1] = (idx >> 8) & 0xff;
    packet[2] = idx & 0xff;
    packet[3] = 0x01;
    packet[4] = (0xcc + 0 + 42 + 1) & 0xff;
    driver.feedRx(packet);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(42, true);
  });

  it('parses a release sensor packet', () => {
    const driver = makeDriver(192);
    const cb = vi.fn();
    driver.onSensorEvent(cb);

    const packet = Buffer.from([0xcc, 0x00, 0x07, 0x00, (0xcc + 7) & 0xff]);
    driver.feedRx(packet);
    expect(cb).toHaveBeenCalledWith(7, false);
  });

  it('drops a sensor packet with a bad checksum', () => {
    const driver = makeDriver(192);
    const cb = vi.fn();
    driver.onSensorEvent(cb);

    const packet = Buffer.from([0xcc, 0x00, 0x05, 0x01, 0x00]); // wrong checksum
    driver.feedRx(packet);
    expect(cb).not.toHaveBeenCalled();
  });

  it('resyncs past garbage bytes to find the next valid sensor packet', () => {
    const driver = makeDriver(192);
    const cb = vi.fn();
    driver.onSensorEvent(cb);

    const garbage = Buffer.from([0x01, 0x02, 0x03]);
    const packet = Buffer.from([0xcc, 0x00, 0x09, 0x01, (0xcc + 9 + 1) & 0xff]);
    driver.feedRx(Buffer.concat([garbage, packet]));

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(9, true);
  });

  it('handles split sensor packets across multiple feeds', () => {
    const driver = makeDriver(192);
    const cb = vi.fn();
    driver.onSensorEvent(cb);

    const idx = 100;
    const full = Buffer.from([
      0xcc,
      (idx >> 8) & 0xff,
      idx & 0xff,
      0x01,
      (0xcc + (idx >> 8) + (idx & 0xff) + 1) & 0xff,
    ]);
    driver.feedRx(full.subarray(0, 2));
    expect(cb).not.toHaveBeenCalled();
    driver.feedRx(full.subarray(2));
    expect(cb).toHaveBeenCalledWith(idx, true);
  });

  it('ignores out-of-range tile indices on setTileColor', () => {
    const driver = makeDriver(16);
    expect(() => driver.setTileColor(-1, 1, 2, 3)).not.toThrow();
    expect(() => driver.setTileColor(99, 1, 2, 3)).not.toThrow();
  });
});
