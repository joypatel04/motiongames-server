import type { Config } from '@/config.js';
import type { ITileDriver } from './driver.interface.js';
import { MockDriver } from './mock.driver.js';
import { MokaDriver } from './moka.driver.js';

export function createDriver(cfg: Config): ITileDriver {
  const tileCount = cfg.tileRows * cfg.tileCols;
  // TILE_DRIVER takes precedence when set (preferred env name going forward),
  // otherwise fall back to the legacy DRIVER_MODE values from config.
  const mode = (process.env.TILE_DRIVER ?? cfg.driverMode).toLowerCase();
  switch (mode) {
    case 'mock':
      return new MockDriver({ tileCount });
    case 'moka':
    case 'moka-serial':
      return new MokaDriver({
        serialPort: cfg.mokaSerialPort,
        baudRate: cfg.mokaBaudRate,
        tileCount,
      });
    case 'moka-tcp':
    case 'ysam':
      throw new Error(`Driver mode "${mode}" is not implemented yet`);
    default:
      throw new Error(`Unknown driver mode: ${mode}`);
  }
}
