import type { DB } from '@/db/database.js';
import { generateId } from '@/db/database.js';
import { readFileSync } from 'node:fs';

export interface GameRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  scoring_type: string;
  min_players: number;
  max_players: number;
  default_duration_seconds: number;
  difficulty_levels: string;
  is_active: number;
  is_premium: number;
  created_at: string;
  definition: string | null;
  version: string | null;
  status: string | null;
}

export interface CloudGameInput {
  id: string;
  name: string;
  slug: string;
  category: string;
  scoringType: string;
  minPlayers: number;
  maxPlayers: number;
  defaultDurationSeconds: number;
  /** JSON-encoded difficulty levels array. */
  difficultyLevels: string;
  /** JSON-encoded full GameDefinition. */
  definition: string;
  version: string;
  status: string;
}

export interface NewGame {
  name: string;
  slug: string;
  category?: string;
  scoringType?: string;
  minPlayers?: number;
  maxPlayers?: number;
  defaultDurationSeconds?: number;
}

export class GamesRepository {
  constructor(private readonly db: DB) {}

  list(): GameRow[] {
    return this.db
      .prepare('SELECT * FROM arena_games WHERE is_active = 1 ORDER BY name')
      .all() as GameRow[];
  }

  getBySlug(slug: string): GameRow | undefined {
    return this.db
      .prepare('SELECT * FROM arena_games WHERE slug = ?')
      .get(slug) as GameRow | undefined;
  }

  getById(id: string): GameRow | undefined {
    return this.db.prepare('SELECT * FROM arena_games WHERE id = ?').get(id) as
      | GameRow
      | undefined;
  }

  insert(game: NewGame): GameRow {
    const id = generateId();
    this.db
      .prepare(
        `INSERT INTO arena_games
        (id, name, slug, category, scoring_type, min_players, max_players, default_duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        game.name,
        game.slug,
        game.category ?? 'action',
        game.scoringType ?? 'points',
        game.minPlayers ?? 1,
        game.maxPlayers ?? 8,
        game.defaultDurationSeconds ?? 60,
      );
    return this.getById(id) as GameRow;
  }

  /** Insert any default games that are not already in the catalog. */
  seedDefaults(defaults: NewGame[]): void {
    for (const g of defaults) {
      if (!this.getBySlug(g.slug)) this.insert(g);
    }
  }

  /** Insert-or-update a game row sourced from Supabase / the cloud catalog. */
  upsertFromCloud(input: CloudGameInput): void {
    this.db
      .prepare(
        `INSERT INTO arena_games (
          id, name, slug, category, scoring_type,
          min_players, max_players, default_duration_seconds,
          difficulty_levels, definition, version, status, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          category = excluded.category,
          scoring_type = excluded.scoring_type,
          min_players = excluded.min_players,
          max_players = excluded.max_players,
          default_duration_seconds = excluded.default_duration_seconds,
          difficulty_levels = excluded.difficulty_levels,
          definition = excluded.definition,
          version = excluded.version,
          status = excluded.status`,
      )
      .run(
        input.id,
        input.name,
        input.slug,
        input.category,
        input.scoringType,
        input.minPlayers,
        input.maxPlayers,
        input.defaultDurationSeconds,
        input.difficultyLevels,
        input.definition,
        input.version,
        input.status,
      );
  }

  /** Read a GameDefinition JSON file from disk and seed it as a local game. */
  seedFromJsonFile(filePath: string): void {
    const raw = readFileSync(filePath, 'utf-8');
    const def = JSON.parse(raw) as Record<string, unknown>;
    const id = (typeof def.id === 'string' ? def.id : null) ?? generateId();
    const slug = deriveSlug(typeof def.id === 'string' ? def.id : null, def.slug, def.name);
    const players = (def.players ?? {}) as { min?: number; max?: number };
    const duration = (def.duration ?? {}) as { seconds?: number };
    const scoring = (def.scoring ?? {}) as { type?: string };
    const difficulties =
      (def.difficultyPresets as Record<string, unknown> | undefined) ??
      (def.difficulties as Record<string, unknown> | undefined) ??
      {};

    this.upsertFromCloud({
      id,
      name: typeof def.name === 'string' ? def.name : slug,
      slug,
      category: typeof def.category === 'string' ? def.category : 'action',
      scoringType: scoring.type ?? 'points',
      minPlayers: typeof players.min === 'number' ? players.min : 1,
      maxPlayers: typeof players.max === 'number' ? players.max : 8,
      defaultDurationSeconds: typeof duration.seconds === 'number' ? duration.seconds : 60,
      difficultyLevels: JSON.stringify(Object.keys(difficulties)),
      definition: raw,
      version: typeof def.version === 'string' ? def.version : '1.0.0',
      status: typeof def.status === 'string' ? def.status : 'ready',
    });
  }
}

function deriveSlug(id: string | null, slug: unknown, name: unknown): string {
  if (typeof slug === 'string' && slug.length > 0) return slug;
  if (id) return id.replace(/^preset_/, '').replace(/_/g, '-');
  if (typeof name === 'string') return name.toLowerCase().replace(/\s+/g, '-');
  return generateId();
}

export const DEFAULT_GAMES: NewGame[] = [
  {
    name: 'Whack-a-Mole',
    slug: 'whack-a-mole',
    category: 'action',
    scoringType: 'points',
    minPlayers: 1,
    maxPlayers: 4,
    defaultDurationSeconds: 60,
  },
  {
    name: 'Lava Run',
    slug: 'lava-run',
    category: 'action',
    scoringType: 'survival',
    minPlayers: 1,
    maxPlayers: 4,
    defaultDurationSeconds: 90,
  },
  {
    name: 'Race to Light',
    slug: 'race-to-light',
    category: 'action',
    scoringType: 'points',
    minPlayers: 1,
    maxPlayers: 4,
    defaultDurationSeconds: 60,
  },
];
