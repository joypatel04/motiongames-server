import 'dotenv/config';

export type DriverMode = 'mock' | 'moka-tcp' | 'moka-serial' | 'ysam';

export interface Config {
  port: number;
  wsPort: number;
  nodeEnv: 'development' | 'production' | 'test';
  driverMode: DriverMode;
  tileRows: number;
  tileCols: number;
  mokaHost: string;
  mokaPort: number;
  mokaSerialPort: string;
  mokaBaudRate: number;
  sqlitePath: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  shopId: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return n;
}

function envStr(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(): Config {
  const driverMode = envStr('DRIVER_MODE', 'mock') as DriverMode;
  const nodeEnv = envStr('NODE_ENV', 'development') as Config['nodeEnv'];
  const logLevel = envStr('LOG_LEVEL', 'info') as Config['logLevel'];

  return {
    port: envInt('PORT', 3000),
    wsPort: envInt('WS_PORT', 3001),
    nodeEnv,
    driverMode,
    tileRows: envInt('TILE_ROWS', 16),
    tileCols: envInt('TILE_COLS', 12),
    mokaHost: envStr('MOKA_HOST', '192.168.1.100'),
    mokaPort: envInt('MOKA_PORT', 8234),
    mokaSerialPort: envStr('MOKA_SERIAL_PORT', '/dev/ttyUSB0'),
    mokaBaudRate: envInt('MOKA_BAUD_RATE', 115200),
    sqlitePath: envStr('SQLITE_PATH', './data/arena.db'),
    supabaseUrl: envStr('SUPABASE_URL', ''),
    supabaseAnonKey: envStr('SUPABASE_ANON_KEY', ''),
    shopId: envStr('SHOP_ID', ''),
    logLevel,
  };
}

export const config: Config = loadConfig();
