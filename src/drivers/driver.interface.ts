import type { RGB } from '@/utils/color.js';

export interface TileUpdate {
  index: number;
  r: number;
  g: number;
  b: number;
}

export type SensorEventCallback = (tileIndex: number, pressed: boolean) => void;

export interface ITileDriver {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setTileColor(tileIndex: number, r: number, g: number, b: number): void;
  setAllTiles(colors: RGB[]): void;
  setBatchTiles(updates: TileUpdate[]): void;
  onSensorEvent(callback: SensorEventCallback): void;
  getTileCount(): number;
  isConnected(): boolean;
}
