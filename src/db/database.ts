import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

export type DB = Database.Database;

export interface DatabaseOptions {
  path: string; // ':memory:' for tests
  readonly?: boolean;
}

function loadMigration(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(here, 'migrations', '001_initial.sql');
  return readFileSync(filePath, 'utf8');
}

export function openDatabase(opts: DatabaseOptions): DB {
  if (opts.path !== ':memory:') {
    const dir = dirname(resolve(opts.path));
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }
  const db = new Database(opts.path, { readonly: opts.readonly ?? false });
  db.pragma('foreign_keys = ON');
  if (opts.path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function runMigrations(db: DB): void {
  const sql = loadMigration();
  db.exec(sql);
  applyCatalogColumns(db);
}

interface PragmaColumn {
  name: string;
}

/**
 * Idempotently adds JSON-game catalog columns (definition/version/status) to
 * arena_games. SQLite lacks `ADD COLUMN IF NOT EXISTS`, so we PRAGMA first.
 */
function applyCatalogColumns(db: DB): void {
  const cols = db.prepare("PRAGMA table_info('arena_games')").all() as PragmaColumn[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('definition')) {
    db.exec('ALTER TABLE arena_games ADD COLUMN definition TEXT');
  }
  if (!names.has('version')) {
    db.exec("ALTER TABLE arena_games ADD COLUMN version TEXT DEFAULT '1.0.0'");
  }
  if (!names.has('status')) {
    db.exec("ALTER TABLE arena_games ADD COLUMN status TEXT DEFAULT 'ready'");
  }
}

export function generateId(): string {
  // 16 random bytes → 32 hex characters, matches schema default
  const arr = new Uint8Array(16);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return s;
}

export function nowISO(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
}
