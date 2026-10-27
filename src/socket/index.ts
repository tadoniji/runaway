import { Server, Socket } from 'socket.io';
import { GameManager } from '../GameManager';
import {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types';

export type AppSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Helper to build standard room names
 */
export const getGameRoom = (gameId: string) => `game:${gameId}`;
export const getHunterRoom = (gameId: string) => `game:${gameId}:hunters`;
export const getRunnerRoom = (gameId: string) => `game:${gameId}:runners`;

export function setupSocketHandlers(io: AppSocketServer): void {
  const gameManager = GameManager.getInstance();

  io.on('connection', (socket: AppSocket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    // 1. JOIN_GAME
    socket.on('join_game', (payload, callback) => {
      try {
        const { gameId, role, name } = payload;
        if (!gameId || !role) {
          const errMsg = 'gameId et role ("RUNNER" | "HUNTER") sont obligatoires.';
          socket.emit('error_message', { code: 'INVALID_PAYLOAD', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        // Store identity in socket data
        socket.data.gameId = gameId;
        socket.data.playerId = socket.id;
        socket.data.role = role;
        socket.data.name = name;

        // Join Socket.IO rooms
        const gameRoom = getGameRoom(gameId);
        const roleRoom = role === 'HUNTER' ? getHunterRoom(gameId) : getRunnerRoom(gameId);

        socket.join(gameRoom);
        socket.join(roleRoom);

        // Register in GameManager
        const { game, player } = gameManager.addPlayer(gameId, {
          id: socket.id,
          role,
          name,
        });

        console.log(`[Socket.IO] Player "${player.name}" (${player.role}) joined game "${gameId}"`);

        // Notify other room members
        socket.to(gameRoom).emit('player_joined', player);

        // Send updated state to all in the game
        io.to(gameRoom).emit('game_state_update', game);

        callback?.({ success: true, state: game });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur interne lors du join_game';
        socket.emit('error_message', { code: 'JOIN_ERROR', message });
        callback?.({ success: false, error: message });
      }
    });

    // 2. TRANSIT_START
    socket.on('transit_start', (payload, callback) => {
      try {
        const gameId = payload?.gameId || socket.data.gameId;
        if (!gameId) {
          const errMsg = 'gameId manquant pour transit_start.';
          socket.emit('error_message', { code: 'MISSING_GAME_ID', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const result = gameManager.startTransit(gameId, socket.id, payload.mode);
        if (!result.success || !result.game) {
          const errMsg = result.error || 'Impossible de démarrer le transit.';
          socket.emit('error_message', { code: 'TRANSIT_START_REJECTED', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const gameRoom = getGameRoom(gameId);
        if (result.game.activeTransit) {
          io.to(gameRoom).emit('transit_started', result.game.activeTransit);
        }
        io.to(gameRoom).emit('game_state_update', result.game);

        console.log(`[Transit] Runner started "${payload.mode}" in game "${gameId}"`);
        callback?.({ success: true, state: result.game });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors du démarrage du transit';
        socket.emit('error_message', { code: 'TRANSIT_START_ERROR', message });
        callback?.({ success: false, error: message });
      }
    });

    // 3. TRANSIT_STOP
    socket.on('transit_stop', (payload, callback) => {
      try {
        const gameId = payload?.gameId || socket.data.gameId;
        if (!gameId) {
          const errMsg = 'gameId manquant pour transit_stop.';
          socket.emit('error_message', { code: 'MISSING_GAME_ID', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const result = gameManager.stopTransit(gameId, socket.id);
        if (!result.success || !result.game || !result.report) {
          const errMsg = result.error || 'Impossible d\'arrêter le transit.';
          socket.emit('error_message', { code: 'TRANSIT_STOP_REJECTED', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const gameRoom = getGameRoom(gameId);
        const hunterRoom = getHunterRoom(gameId);

        // Notify everyone about transit completion and cost breakdown
        io.to(gameRoom).emit('transit_stopped', result.report);

        // If overdraft occurred: trigger suspect alert to hunters
        if (result.report.penaltiesApplied && result.report.curseApplied && result.report.vetoUntil) {
          console.warn(`[Transit] OVERDRAFT! Game "${gameId}" coins: ${result.game.coins}. Suspect alert triggered.`);
          const alertPayload = {
            reason: `Le Runner est à découvert (${result.game.coins} coins) après son trajet en ${result.report.mode}.`,
            coins: result.game.coins,
            vetoUntil: result.report.vetoUntil,
            curse: result.report.curseApplied,
          };

          // Broadcast alert to hunters
          io.to(hunterRoom).emit('suspect_alert', alertPayload);
          // Also inform the runner
          socket.emit('suspect_alert', alertPayload);
        }

        io.to(gameRoom).emit('game_state_update', result.game);

        callback?.({
          success: true,
          report: result.report,
          state: result.game,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors de l\'arrêt du transit';
        socket.emit('error_message', { code: 'TRANSIT_STOP_ERROR', message });
        callback?.({ success: false, error: message });
      }
    });

    // 4. PING_GPS
    socket.on('ping_gps', (payload, callback) => {
      try {
        const gameId = payload?.gameId || socket.data.gameId;
        if (!gameId) {
          const errMsg = 'gameId manquant pour ping_gps.';
          socket.emit('error_message', { code: 'MISSING_GAME_ID', message: errMsg });
          callback?.({ success: false, broadcasted: false, error: errMsg });
          return;
        }

        if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') {
          const errMsg = 'Coordonnées GPS invalides (lat et lng doivent être des nombres).';
          socket.emit('error_message', { code: 'INVALID_COORDINATES', message: errMsg });
          callback?.({ success: false, broadcasted: false, error: errMsg });
          return;
        }

        const result = gameManager.recordGpsPing(gameId, socket.id, {
          lat: payload.lat,
          lng: payload.lng,
          altitude: payload.altitude,
          speed: payload.speed,
        });

        if (!result.success) {
          socket.emit('error_message', { code: 'GPS_PING_REJECTED', message: result.error || 'Erreur' });
          callback?.({ success: false, broadcasted: false, error: result.error });
          return;
        }

        // If condition met (periodic ping or sonar curse), broadcast to hunters room
        if (result.broadcastToHunters && result.ping) {
          const hunterRoom = getHunterRoom(gameId);
          console.log(`[GPS] Broadcasting location to hunters for game "${gameId}" (reason: ${result.ping.triggerReason})`);
          io.to(hunterRoom).emit('hunter_ping', result.ping);
        }

        callback?.({
          success: true,
          broadcasted: result.broadcastToHunters,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors du traitement du ping GPS';
        socket.emit('error_message', { code: 'GPS_PING_ERROR', message });
        callback?.({ success: false, broadcasted: false, error: message });
      }
    });

    // 5. EXPORT_GPX
    socket.on('export_gpx', (payload, callback) => {
      try {
        const gameId = payload?.gameId || socket.data.gameId;
        if (!gameId) {
          const errMsg = 'gameId manquant pour export_gpx.';
          socket.emit('error_message', { code: 'MISSING_GAME_ID', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const result = gameManager.exportGpx(gameId);
        if (!result.success || !result.gpx) {
          const errMsg = result.error || 'Export GPX impossible.';
          socket.emit('error_message', { code: 'GPX_EXPORT_ERROR', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        socket.emit('gpx_exported', {
          gpx: result.gpx,
          filename: result.filename || `game_${gameId}.gpx`,
        });

        callback?.({ success: true, gpx: result.gpx });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors de l\'export GPX';
        socket.emit('error_message', { code: 'GPX_EXPORT_EXCEPTION', message });
        callback?.({ success: false, error: message });
      }
    });

    // DISCONNECT
    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (reason: ${reason})`);
      const { game, removedPlayer } = gameManager.removePlayer(socket.id);
      if (game && removedPlayer) {
        const gameRoom = getGameRoom(game.gameId);
        socket.to(gameRoom).emit('player_left', socket.id);
        io.to(gameRoom).emit('game_state_update', game);
      }
    });
  });
}
