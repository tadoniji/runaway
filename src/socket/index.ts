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
 * Standard Room names
 */
export const getGameRoom = (gameCode: string) => `game:${gameCode.toUpperCase()}`;
export const getHunterRoom = (gameCode: string) => `game:${gameCode.toUpperCase()}:hunters`;
export const getRunnerRoom = (gameCode: string) => `game:${gameCode.toUpperCase()}:runners`;

export function setupSocketHandlers(io: AppSocketServer): void {
  const gameManager = GameManager.getInstance();

  io.on('connection', (socket: AppSocket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    // Helper to extract gameCode
    const resolveGameCode = (payload?: { gameCode?: string; gameId?: string }): string | undefined => {
      const code = payload?.gameCode || payload?.gameId || socket.data.gameCode;
      return code ? code.trim().toUpperCase() : undefined;
    };

    // 1. CREATE_GAME
    socket.on('create_game', (payload, callback) => {
      try {
        const { hostName, avatarUrl, wantsRunner, settings } = payload;
        const session = gameManager.createGame(
          socket.id,
          hostName,
          avatarUrl,
          wantsRunner,
          settings
        );

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = socket.id;
        socket.data.name = hostName;
        socket.data.role = wantsRunner ? 'RUNNER' : 'UNDECIDED';

        const gameRoom = getGameRoom(session.gameCode);
        socket.join(gameRoom);
        if (socket.data.role === 'RUNNER') {
          socket.join(getRunnerRoom(session.gameCode));
        }

        console.log(`[Lobby] Game created: "${session.gameCode}" by "${hostName}"`);
        const serialized = gameManager.serializeSession(session);
        callback?.({ success: true, gameCode: session.gameCode, session: serialized });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors de la création de la partie';
        socket.emit('error_message', { code: 'CREATE_ERROR', message });
        callback?.({ success: false, error: message });
      }
    });

    // 2. JOIN_GAME
    socket.on('join_game', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) {
          const errMsg = 'Le code de partie (gameCode) est obligatoire.';
          socket.emit('error_message', { code: 'MISSING_GAME_CODE', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const { session, player } = gameManager.addPlayer(gameCode, {
          id: socket.id,
          name: payload.name,
          avatarUrl: payload.avatarUrl,
          wantsRunner: payload.wantsRunner,
          role: payload.role,
        });

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = socket.id;
        socket.data.role = player.role;
        socket.data.name = player.name;

        const gameRoom = getGameRoom(session.gameCode);
        socket.join(gameRoom);

        if (player.role === 'RUNNER') {
          socket.join(getRunnerRoom(session.gameCode));
        } else if (player.role === 'HUNTER') {
          socket.join(getHunterRoom(session.gameCode));
        }

        console.log(`[Lobby] Player "${player.name}" joined game "${session.gameCode}"`);

        const serialized = gameManager.serializeSession(session);
        socket.to(gameRoom).emit('player_joined', player);
        io.to(gameRoom).emit('game_state_update', serialized);

        callback?.({ success: true, session: serialized });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Erreur lors de la connexion à la session';
        socket.emit('error_message', { code: 'JOIN_ERROR', message });
        callback?.({ success: false, error: message });
      }
    });

    // 3. SET_READY
    socket.on('set_ready', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.setPlayerReady(gameCode, socket.id, payload.isReady);
        if (result.success && result.session) {
          const serialized = gameManager.serializeSession(result.session);
          io.to(getGameRoom(gameCode)).emit('game_state_update', serialized);
          callback?.({ success: true, session: serialized });
        } else {
          callback?.({ success: false, error: result.error });
        }
      } catch (err) {
        callback?.({ success: false, error: 'Erreur set_ready' });
      }
    });

    // 4. SET_WANTS_RUNNER
    socket.on('set_wants_runner', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.setWantsRunner(gameCode, socket.id, payload.wantsRunner);
        if (result.success && result.session) {
          const serialized = gameManager.serializeSession(result.session);
          io.to(getGameRoom(gameCode)).emit('game_state_update', serialized);
          callback?.({ success: true, session: serialized });
        } else {
          callback?.({ success: false, error: result.error });
        }
      } catch (err) {
        callback?.({ success: false, error: 'Erreur set_wants_runner' });
      }
    });

    // 5. UPDATE_SETTINGS (Host only)
    socket.on('update_settings', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.updateSettings(gameCode, socket.id, payload.settings);
        if (result.success && result.session) {
          const serialized = gameManager.serializeSession(result.session);
          io.to(getGameRoom(gameCode)).emit('game_state_update', serialized);
          callback?.({ success: true, session: serialized });
        } else {
          callback?.({ success: false, error: result.error });
        }
      } catch (err) {
        callback?.({ success: false, error: 'Erreur update_settings' });
      }
    });

    // 6. ASSIGN_ROLE (Host only)
    socket.on('assign_role', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.assignRole(
          gameCode,
          socket.id,
          payload.targetPlayerId,
          payload.role
        );
        if (result.success && result.session) {
          const targetSocket = io.sockets.sockets.get(payload.targetPlayerId);
          if (targetSocket) {
            targetSocket.data.role = payload.role;
            if (payload.role === 'RUNNER') {
              targetSocket.join(getRunnerRoom(gameCode));
              targetSocket.leave(getHunterRoom(gameCode));
            } else if (payload.role === 'HUNTER') {
              targetSocket.join(getHunterRoom(gameCode));
              targetSocket.leave(getRunnerRoom(gameCode));
            }
          }

          const serialized = gameManager.serializeSession(result.session);
          io.to(getGameRoom(gameCode)).emit('game_state_update', serialized);
          callback?.({ success: true, session: serialized });
        } else {
          callback?.({ success: false, error: result.error });
        }
      } catch (err) {
        callback?.({ success: false, error: 'Erreur assign_role' });
      }
    });

    // 7. START_GAME (Host only)
    socket.on('start_game', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.startGame(gameCode, socket.id);
        if (!result.success || !result.session) {
          callback?.({ success: false, error: result.error });
          return;
        }

        const gameRoom = getGameRoom(gameCode);
        const serialized = gameManager.serializeSession(result.session);

        // Update room memberships according to final roles
        result.session.players.forEach((player) => {
          const s = io.sockets.sockets.get(player.id);
          if (s) {
            s.data.role = player.role;
            if (player.role === 'RUNNER') {
              s.join(getRunnerRoom(gameCode));
              s.leave(getHunterRoom(gameCode));
            } else {
              s.join(getHunterRoom(gameCode));
              s.leave(getRunnerRoom(gameCode));
            }
          }
        });

        io.to(gameRoom).emit('phase_changed', {
          phase: result.session.phase,
          jailTimeEndsAt: result.session.jailTimeEndsAt,
        });
        io.to(gameRoom).emit('game_state_update', serialized);

        console.log(`[Game] Started in mode "${result.session.phase}" for game "${gameCode}"`);
        callback?.({ success: true, session: serialized });
      } catch (err) {
        callback?.({ success: false, error: 'Erreur start_game' });
      }
    });

    // 8. TRANSIT_START
    socket.on('transit_start', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) {
          callback?.({ success: false, error: 'gameCode manquant' });
          return;
        }

        const result = gameManager.startTransit(gameCode, socket.id, payload.mode);
        if (!result.success || !result.session) {
          const errMsg = result.error || 'Impossible de démarrer le transport';
          socket.emit('error_message', { code: 'TRANSIT_START_REJECTED', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const gameRoom = getGameRoom(gameCode);
        const serialized = gameManager.serializeSession(result.session);

        if (result.session.activeTransit) {
          io.to(gameRoom).emit('transit_started', result.session.activeTransit);
        }
        io.to(gameRoom).emit('game_state_update', serialized);

        callback?.({ success: true, session: serialized });
      } catch (err) {
        callback?.({ success: false, error: 'Erreur transit_start' });
      }
    });

    // 9. TRANSIT_STOP
    socket.on('transit_stop', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) {
          callback?.({ success: false, error: 'gameCode manquant' });
          return;
        }

        const result = gameManager.stopTransit(gameCode, socket.id);
        if (!result.success || !result.session || !result.report) {
          const errMsg = result.error || 'Impossible d\'arrêter le transport';
          socket.emit('error_message', { code: 'TRANSIT_STOP_REJECTED', message: errMsg });
          callback?.({ success: false, error: errMsg });
          return;
        }

        const gameRoom = getGameRoom(gameCode);
        const hunterRoom = getHunterRoom(gameCode);
        const serialized = gameManager.serializeSession(result.session);

        io.to(gameRoom).emit('transit_stopped', result.report);

        if (result.report.penaltiesApplied && result.report.vetoUntil) {
          const alertPayload = {
            reason: `Le Runner est à découvert (${result.session.runnerCoins} coins) après son trajet en ${result.report.mode}.`,
            coins: result.session.runnerCoins,
            vetoUntil: result.report.vetoUntil,
            curse: result.report.curseApplied,
          };
          io.to(hunterRoom).emit('suspect_alert', alertPayload);
          socket.emit('suspect_alert', alertPayload);
        }

        io.to(gameRoom).emit('game_state_update', serialized);

        callback?.({ success: true, report: result.report, session: serialized });
      } catch (err) {
        callback?.({ success: false, error: 'Erreur transit_stop' });
      }
    });

    // 10. PING_GPS
    socket.on('ping_gps', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) {
          callback?.({ success: false, broadcasted: false, error: 'gameCode manquant' });
          return;
        }

        if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') {
          callback?.({ success: false, broadcasted: false, error: 'Coordonnées GPS invalides' });
          return;
        }

        const result = gameManager.recordPosition(gameCode, socket.id, {
          lat: payload.lat,
          lng: payload.lng,
          altitude: payload.altitude,
          speed: payload.speed,
        });

        if (!result.success || !result.session) {
          callback?.({ success: false, broadcasted: false, error: result.error });
          return;
        }

        const hunterRoom = getHunterRoom(gameCode);

        // If Runner broadcast is due
        if (result.broadcastToHunters && result.ping) {
          io.to(hunterRoom).emit('hunter_ping', result.ping);
        }

        // If Hunter moved, broadcast location to other hunters
        if (socket.data.role === 'HUNTER') {
          socket.to(hunterRoom).emit('hunter_location_update', {
            hunterId: socket.id,
            name: socket.data.name || 'Hunter',
            lat: payload.lat,
            lng: payload.lng,
          });
        }

        // Notify hunters if capture is within reach
        if (result.captureOpportunity && result.distanceToRunner !== undefined) {
          io.to(hunterRoom).emit('capture_opportunity', {
            hunterId: socket.id,
            distanceMeters: result.distanceToRunner,
          });
        }

        callback?.({
          success: true,
          broadcasted: result.broadcastToHunters,
          distanceToRunner: result.distanceToRunner,
        });
      } catch (err) {
        callback?.({ success: false, broadcasted: false, error: 'Erreur ping_gps' });
      }
    });

    // 11. ATTEMPT_CAPTURE
    socket.on('attempt_capture', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.attemptCapture(gameCode, socket.id);
        if (!result.success || !result.session) {
          callback?.({ success: false, captured: false, error: result.error });
          return;
        }

        const gameRoom = getGameRoom(gameCode);
        const serialized = gameManager.serializeSession(result.session);

        io.to(gameRoom).emit('runner_captured', {
          hunterId: socket.id,
          hunterName: result.hunterName || 'Hunter',
          timestamp: Date.now(),
        });
        io.to(gameRoom).emit('phase_changed', {
          phase: 'CAPTURED',
          jailTimeEndsAt: null,
        });
        io.to(gameRoom).emit('game_state_update', serialized);

        callback?.({ success: true, captured: true, distanceMeters: result.distanceMeters });
      } catch (err) {
        callback?.({ success: false, error: 'Erreur attempt_capture' });
      }
    });

    // 12. ACCEPT_CURSE
    socket.on('accept_curse', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.acceptCurse(gameCode, socket.id, payload.curse);
        if (result.success && result.session) {
          const serialized = gameManager.serializeSession(result.session);
          io.to(getGameRoom(gameCode)).emit('game_state_update', serialized);
          callback?.({ success: true, session: serialized });
        } else {
          callback?.({ success: false, error: result.error });
        }
      } catch (err) {
        callback?.({ success: false, error: 'Erreur accept_curse' });
      }
    });

    // 13. EXPORT_GPX
    socket.on('export_gpx', (payload, callback) => {
      try {
        const gameCode = resolveGameCode(payload);
        if (!gameCode) return;

        const result = gameManager.exportGpx(gameCode);
        if (!result.success || !result.gpx) {
          callback?.({ success: false, error: result.error });
          return;
        }

        socket.emit('gpx_exported', {
          gpx: result.gpx,
          filename: result.filename || `game_${gameCode}.gpx`,
        });
        callback?.({ success: true, gpx: result.gpx });
      } catch (err) {
        callback?.({ success: false, error: 'Erreur export_gpx' });
      }
    });

    // DISCONNECT
    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (reason: ${reason})`);
      const { session, removedPlayer } = gameManager.removePlayer(socket.id);
      if (session && removedPlayer) {
        const gameRoom = getGameRoom(session.gameCode);
        socket.to(gameRoom).emit('player_left', socket.id);
        const serialized = gameManager.serializeSession(session);
        io.to(gameRoom).emit('game_state_update', serialized);
      }
    });
  });
}
