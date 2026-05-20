import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '@/config.js';
import { logger } from '@/utils/logger.js';
import { createDriver } from '@/drivers/driver.factory.js';
import { WsBroadcastDriver } from '@/drivers/ws-broadcast.driver.js';
import { openDatabase, runMigrations } from '@/db/database.js';
import { DEFAULT_GAMES, GamesRepository } from '@/db/repositories/games.repo.js';
import { SessionsRepository } from '@/db/repositories/sessions.repo.js';
import { ScoresRepository } from '@/db/repositories/scores.repo.js';
import { LeaderboardRepository } from '@/db/repositories/leaderboard.repo.js';
import { SyncQueueRepository } from '@/db/repositories/sync-queue.repo.js';
import { Grid } from '@/engine/grid.js';
import { GameEngine } from '@/engine/engine.js';
import { SessionManager } from '@/server/session-manager.js';
import { ArenaWsServer } from '@/server/ws-server.js';
import { ArenaHttpServer } from '@/server/http-server.js';
import { ScoreSync } from '@/services/score-sync.js';
import { CatalogSync } from '@/services/catalog-sync.js';
import { loadPartnerProfile } from '@/services/partner-config.js';

async function main(): Promise<void> {
  logger.info({ config: { ...config, supabaseAnonKey: '***' } }, 'starting arena-server');

  const db = openDatabase({ path: config.sqlitePath });
  runMigrations(db);

  const games = new GamesRepository(db);
  games.seedDefaults(DEFAULT_GAMES);
  seedLocalPresets(games);

  const sessions = new SessionsRepository(db);
  const scores = new ScoresRepository(db);
  const leaderboard = new LeaderboardRepository(db);
  const syncQueue = new SyncQueueRepository(db);

  const baseDriver = createDriver(config);
  await baseDriver.connect();

  // Wrap the base driver so every tile write also fans out over WebSocket to
  // the floor simulator. The ws-server reference is attached lazily because
  // it needs the engine in its deps.
  const broadcastDriver = new WsBroadcastDriver(baseDriver);

  const grid = new Grid({ rows: config.tileRows, cols: config.tileCols, serpentine: true });
  const engine = new GameEngine({ driver: broadcastDriver, grid });

  const sessionManager = new SessionManager({
    engine,
    games,
    sessions,
    scores,
    leaderboard,
    syncQueue,
  });

  const httpServer = new ArenaHttpServer({
    port: config.port,
    games,
    sessionManager,
  });

  const partnerProfile = await loadPartnerProfile();
  const wsServer = new ArenaWsServer({
    server: httpServer.server,
    deps: { games, sessions, leaderboard, sessionManager, engine },
    partnerProfile,
  });

  broadcastDriver.attachWsServer(wsServer);

  engine.emitter.on('tick', (data) => {
    const payload = data as { elapsedMs?: number; remainingMs?: number };
    broadcastDriver.setTimingContext(payload.elapsedMs ?? 0, payload.remainingMs ?? 0);
  });

  await httpServer.listen();
  await wsServer.ready();

  const scoreSyncIntervalMs = Number(process.env.SCORE_SYNC_INTERVAL_MS ?? 10_000);
  const scoreSync = new ScoreSync({
    syncQueue,
    intervalMs: scoreSyncIntervalMs,
    shopId: config.shopId,
  });
  scoreSync.start();

  const catalogSyncIntervalMs = Number(process.env.CATALOG_SYNC_INTERVAL_MS ?? 60_000);
  const catalogSync = new CatalogSync({ games, intervalMs: catalogSyncIntervalMs });
  await catalogSync.start();

  logger.info(
    {
      httpPort: config.port,
      tileCount: grid.tileCount,
      driver: config.driverMode,
      simulator: `http://localhost:${config.port}/simulator`,
      games: DEFAULT_GAMES.map((g) => g.slug),
    },
    'arena-server ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');
    try {
      catalogSync.stop();
      scoreSync.stop();
      await wsServer.close();
      await httpServer.close();
      await baseDriver.disconnect();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Seed local GameDefinition JSON files from the presets/ directory. */
function seedLocalPresets(games: GamesRepository): void {
  const presetsDir = resolve(process.cwd(), 'presets');
  if (!existsSync(presetsDir)) return;
  const files = readdirSync(presetsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      games.seedFromJsonFile(join(presetsDir, file));
      logger.info({ file }, 'seeded game from local preset');
    } catch (err) {
      logger.warn({ err, file }, 'failed to seed local preset');
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
