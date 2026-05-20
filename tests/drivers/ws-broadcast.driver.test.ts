import { describe, it, expect, vi } from 'vitest';
import { MockDriver } from '@/drivers/mock.driver.js';
import { WsBroadcastDriver } from '@/drivers/ws-broadcast.driver.js';
import type { ArenaWsServer } from '@/server/ws-server.js';

function makeFakeWs(): { send: ReturnType<typeof vi.fn>; server: ArenaWsServer } {
  const send = vi.fn();
  // We only use sendTileUpdate; cast is safe.
  const server = { sendTileUpdate: send } as unknown as ArenaWsServer;
  return { send, server };
}

describe('WsBroadcastDriver', () => {
  it('forwards setTileColor to inner and broadcasts a single-tile update', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const { send, server } = makeFakeWs();
    const drv = new WsBroadcastDriver(inner, server);
    drv.setTimingContext(1000, 5000);

    drv.setTileColor(3, 200, 100, 50);

    expect(inner.getTileColor(3)).toEqual({ r: 200, g: 100, b: 50 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      [{ index: 3, r: 200, g: 100, b: 50 }],
      1000,
      5000,
    );
  });

  it('forwards setBatchTiles and broadcasts batched update', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const { send, server } = makeFakeWs();
    const drv = new WsBroadcastDriver(inner, server);

    drv.setBatchTiles([
      { index: 0, r: 1, g: 2, b: 3 },
      { index: 5, r: 9, g: 8, b: 7 },
    ]);

    expect(inner.getTileColor(0)).toEqual({ r: 1, g: 2, b: 3 });
    expect(send).toHaveBeenCalledWith(
      [
        { index: 0, r: 1, g: 2, b: 3 },
        { index: 5, r: 9, g: 8, b: 7 },
      ],
      0,
      0,
    );
  });

  it('skips broadcast on empty batch', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const { send, server } = makeFakeWs();
    const drv = new WsBroadcastDriver(inner, server);
    drv.setBatchTiles([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('is safe to call before attachWsServer (no broadcast)', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const drv = new WsBroadcastDriver(inner);
    expect(() => drv.setTileColor(0, 1, 2, 3)).not.toThrow();
    expect(inner.getTileColor(0)).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('attachWsServer wires up broadcasting after construction', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const drv = new WsBroadcastDriver(inner);
    const { send, server } = makeFakeWs();
    drv.attachWsServer(server);
    drv.setTileColor(2, 10, 20, 30);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('forwards sensor callbacks to the inner driver', () => {
    const inner = new MockDriver({ tileCount: 16 });
    const drv = new WsBroadcastDriver(inner);
    const cb = vi.fn();
    drv.onSensorEvent(cb);
    inner.pressTile(7);
    expect(cb).toHaveBeenCalledWith(7, true);
  });

  it('reports connection state and tile count from the inner driver', async () => {
    const inner = new MockDriver({ tileCount: 24 });
    const drv = new WsBroadcastDriver(inner);
    expect(drv.getTileCount()).toBe(24);
    expect(drv.isConnected()).toBe(false);
    await drv.connect();
    expect(drv.isConnected()).toBe(true);
    await drv.disconnect();
    expect(drv.isConnected()).toBe(false);
  });
});
