import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleMessage, type HandlerDeps } from './ws-handlers.js';
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type TileColor,
} from './ws-protocol.js';
import { logger } from '@/utils/logger.js';
import type { PartnerProfile } from '@/services/partner-config.js';

export interface WsServerOptions {
  /** Listen on a dedicated port (used when no HTTP server is provided). */
  port?: number;
  /** Attach to an existing HTTP server under a path (default '/ws'). */
  server?: HttpServer;
  path?: string;
  deps: HandlerDeps;
  /** Partner profile sent to every connecting client; refreshable via setPartnerProfile. */
  partnerProfile?: PartnerProfile | null;
}

export class ArenaWsServer {
  private readonly wss: WebSocketServer;
  private readonly deps: HandlerDeps;
  private readonly clients = new Set<WebSocket>();
  private partnerProfile: PartnerProfile | null;

  constructor(options: WsServerOptions) {
    this.deps = options.deps;
    this.partnerProfile = options.partnerProfile ?? null;
    if (options.server) {
      this.wss = new WebSocketServer({ server: options.server, path: options.path ?? '/ws' });
    } else if (options.port !== undefined) {
      this.wss = new WebSocketServer({ port: options.port });
    } else {
      throw new Error('WsServerOptions requires either { server } or { port }');
    }
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.wireBroadcast();
  }

  /** Wait for the underlying server to start listening. */
  ready(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss.address()) {
        resolve();
        return;
      }
      this.wss.once('listening', () => resolve());
    });
  }

  close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  broadcast(message: ServerMessage): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  /** Push a tile_update frame to all clients (used by WsBroadcastDriver). */
  sendTileUpdate(tiles: TileColor[], elapsed: number, remaining: number): void {
    if (tiles.length === 0) return;
    this.broadcast({ type: 'tile_update', tiles, elapsed, remaining });
  }

  /** Number of currently connected clients (test helper). */
  clientCount(): number {
    return this.clients.size;
  }

  /** Update the partner profile sent to subsequent clients (and re-broadcast to current ones). */
  setPartnerProfile(profile: PartnerProfile | null): void {
    this.partnerProfile = profile;
    if (profile) {
      this.broadcast({ type: 'partner_profile', profile });
    }
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    const hello: ServerMessage = { type: 'hello', serverVersion: '0.1.0' };
    ws.send(JSON.stringify(hello));
    if (this.partnerProfile) {
      ws.send(
        JSON.stringify({ type: 'partner_profile', profile: this.partnerProfile } satisfies ServerMessage),
      );
    }

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(text);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          } satisfies ServerMessage),
        );
        return;
      }

      if (msg.type === 'sensor') {
        this.handleSensorMessage(msg.tileIndex, msg.pressed);
        return;
      }

      let response: ServerMessage;
      try {
        response = handleMessage(this.deps, msg);
      } catch (err) {
        response = {
          type: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        };
      }
      ws.send(JSON.stringify(response));
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'ws client error');
      this.clients.delete(ws);
    });
  }

  private handleSensorMessage(tileIndex: number, pressed: boolean): void {
    const engine = this.deps.engine;
    engine.emitter.emit(pressed ? 'tile_pressed' : 'tile_released', { tileIndex });
    const game = engine.getGame();
    if (game && engine.getState() === 'running') {
      game.onSensorEvent(tileIndex, pressed);
    }
  }

  private wireBroadcast(): void {
    const e = this.deps.engine.emitter;
    e.on('game_start', () => {
      const game = this.deps.engine.getGame();
      const grid = this.deps.engine.grid;
      this.broadcast({ type: 'game_started', gameSlug: game?.id ?? 'unknown' });
      this.broadcast({
        type: 'game_start',
        gameId: game?.id ?? 'unknown',
        grid: { rows: grid.rows, cols: grid.cols },
        players: this.deps.engine.getPlayers().length,
      });
    });
    e.on('game_pause', () => this.broadcast({ type: 'game_paused' }));
    e.on('game_resume', () => this.broadcast({ type: 'game_resumed' }));
    e.on('score_update', (data) => {
      const payload = data as { playerIndex?: number; score?: number; total?: number };
      this.broadcast({
        type: 'score_update',
        playerIndex: payload.playerIndex ?? 0,
        score: payload.score ?? payload.total ?? 0,
      });
    });
    e.on('game_end', (data) => {
      const sessionId = this.deps.sessionManager.getCurrentSessionId();
      const scores = this.deps.engine.getScores();
      this.broadcast({
        type: 'game_ended',
        sessionId: sessionId ?? 'unknown',
        scores,
      });
      const reason =
        data && typeof (data as { reason?: unknown }).reason === 'string'
          ? ((data as { reason: string }).reason)
          : 'finished';
      this.broadcast({
        type: 'game_end',
        reason,
        scores: scores.map((s) => ({ name: s.name, score: s.score })),
      });
    });
  }
}
