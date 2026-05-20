export interface GridPosition {
  row: number;
  col: number;
}

export interface GridOptions {
  rows: number;
  cols: number;
  /** If true, every other row is reversed (MOKA cabling pattern). */
  serpentine?: boolean;
  rng?: () => number;
}

export class Grid {
  readonly rows: number;
  readonly cols: number;
  readonly serpentine: boolean;
  readonly tileCount: number;
  private readonly rng: () => number;

  constructor(options: GridOptions) {
    if (options.rows <= 0 || options.cols <= 0) {
      throw new Error('Grid rows and cols must be positive');
    }
    this.rows = options.rows;
    this.cols = options.cols;
    this.serpentine = options.serpentine ?? false;
    this.tileCount = this.rows * this.cols;
    this.rng = options.rng ?? Math.random;
  }

  /** Convert (row, col) to a linear tile index. */
  tileIndex(row: number, col: number): number {
    if (!this.isValid(row, col)) {
      throw new RangeError(`Invalid position (${row},${col}) for ${this.rows}x${this.cols} grid`);
    }
    if (this.serpentine && row % 2 === 1) {
      return row * this.cols + (this.cols - 1 - col);
    }
    return row * this.cols + col;
  }

  /** Convert a linear tile index to a (row, col) position. */
  tilePosition(index: number): GridPosition {
    if (index < 0 || index >= this.tileCount) {
      throw new RangeError(`Invalid tile index ${index}`);
    }
    const row = Math.floor(index / this.cols);
    let col = index % this.cols;
    if (this.serpentine && row % 2 === 1) {
      col = this.cols - 1 - col;
    }
    return { row, col };
  }

  /** 4-directional neighbors of a tile, by index. */
  neighbors(index: number): number[] {
    const { row, col } = this.tilePosition(index);
    const out: number[] = [];
    const deltas: Array<[number, number]> = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dr, dc] of deltas) {
      const r = row + dr;
      const c = col + dc;
      if (this.isValid(r, c)) out.push(this.tileIndex(r, c));
    }
    return out;
  }

  /** Manhattan distance between two tile indices. */
  distance(a: number, b: number): number {
    const pa = this.tilePosition(a);
    const pb = this.tilePosition(b);
    return Math.abs(pa.row - pb.row) + Math.abs(pa.col - pb.col);
  }

  /** Bounds check for a (row, col) pair. */
  isValid(row: number, col: number): boolean {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  /** Random valid tile index. */
  randomTile(): number {
    return Math.floor(this.rng() * this.tileCount);
  }

  /** Iterator over all tile indices in linear order. */
  *allTiles(): IterableIterator<number> {
    for (let i = 0; i < this.tileCount; i++) yield i;
  }
}
