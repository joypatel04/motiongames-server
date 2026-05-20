import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '@/db/database.js';
import { GamesRepository } from '@/db/repositories/games.repo.js';

function makeRepo(): GamesRepository {
  const db = openDatabase({ path: ':memory:' });
  runMigrations(db);
  return new GamesRepository(db);
}

describe('GamesRepository', () => {
  let repo: GamesRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  describe('upsertFromCloud', () => {
    it('inserts a new row with full catalog metadata', () => {
      repo.upsertFromCloud({
        id: 'g1',
        name: 'Test Game',
        slug: 'test-game',
        category: 'puzzle',
        scoringType: 'points',
        minPlayers: 1,
        maxPlayers: 4,
        defaultDurationSeconds: 120,
        difficultyLevels: JSON.stringify(['easy', 'hard']),
        definition: JSON.stringify({ description: 'demo' }),
        version: '2.0.0',
        status: 'ready',
      });
      const row = repo.getBySlug('test-game');
      expect(row).toBeDefined();
      expect(row?.id).toBe('g1');
      expect(row?.category).toBe('puzzle');
      expect(row?.version).toBe('2.0.0');
      expect(row?.status).toBe('ready');
      expect(row?.definition).toContain('demo');
    });

    it('updates existing row on slug conflict', () => {
      repo.upsertFromCloud({
        id: 'g1',
        name: 'Original',
        slug: 'same-slug',
        category: 'action',
        scoringType: 'points',
        minPlayers: 1,
        maxPlayers: 2,
        defaultDurationSeconds: 30,
        difficultyLevels: '[]',
        definition: '{}',
        version: '1.0.0',
        status: 'ready',
      });
      repo.upsertFromCloud({
        id: 'g1',
        name: 'Updated',
        slug: 'same-slug',
        category: 'puzzle',
        scoringType: 'time',
        minPlayers: 2,
        maxPlayers: 8,
        defaultDurationSeconds: 60,
        difficultyLevels: '["easy"]',
        definition: '{"updated":true}',
        version: '1.1.0',
        status: 'published',
      });
      const row = repo.getBySlug('same-slug');
      expect(row?.name).toBe('Updated');
      expect(row?.category).toBe('puzzle');
      expect(row?.max_players).toBe(8);
      expect(row?.version).toBe('1.1.0');
      expect(row?.status).toBe('published');
    });
  });

  describe('seedFromJsonFile', () => {
    it('reads a GameDefinition JSON file and seeds it', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'arena-preset-'));
      const file = join(tmp, 'color-rush.json');
      writeFileSync(
        file,
        JSON.stringify({
          id: 'preset_color_rush',
          name: 'Color Rush',
          category: 'action',
          players: { min: 1, max: 4 },
          duration: { seconds: 75 },
          scoring: { type: 'points' },
          difficultyPresets: { easy: {}, medium: {}, hard: {} },
          version: '1.0.0',
        }),
      );

      repo.seedFromJsonFile(file);
      const row = repo.getBySlug('color-rush');
      expect(row).toBeDefined();
      expect(row?.name).toBe('Color Rush');
      expect(row?.default_duration_seconds).toBe(75);
      expect(row?.min_players).toBe(1);
      expect(row?.max_players).toBe(4);
      expect(row?.definition).toContain('color_rush');
      const levels = JSON.parse(row?.difficulty_levels ?? '[]') as string[];
      expect(levels.sort()).toEqual(['easy', 'hard', 'medium']);
    });

    it('falls back to defaults when fields are missing', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'arena-preset-'));
      const file = join(tmp, 'minimal.json');
      writeFileSync(file, JSON.stringify({ id: 'preset_minimal', name: 'Minimal' }));

      repo.seedFromJsonFile(file);
      const row = repo.getBySlug('minimal');
      expect(row).toBeDefined();
      expect(row?.default_duration_seconds).toBe(60);
      expect(row?.scoring_type).toBe('points');
      expect(row?.status).toBe('ready');
    });
  });
});
