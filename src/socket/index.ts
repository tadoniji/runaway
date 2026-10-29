import { Server, Socket } from 'socket.io';
import { GameManager } from '../GameManager';
import {
  ClientToServerEvents,
  GameSession,
  InterServerEvents,
  PlayerRole,
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
 * Standard Room helpers (supporting both legacy game:CODE and new game_CODE formats)
 */
export const getGameRoom = (gameCode: string) => `game_${gameCode.toUpperCase()}`;
export const getHunterRoom = (gameCode: string) => `hunters_${gameCode.toUpperCase()}`;
export const getRunnerRoom = (gameCode: string) => `runners_${gameCode.toUpperCase()}`;

/**
 * Broadcasts an event to all room alias variants (game_CODE, game:CODE, CODE)
 */
export function emitToGame(io: AppSocketServer, gameCode: string, event: any, payload: any): void {
  const code = gameCode.trim().toUpperCase();
  io.to(`game_${code}`)
    .to(`game:${code}`)
    .to(code)
    .emit(event, payload);
}

export function emitToHunters(io: AppSocketServer, gameCode: string, event: any, payload: any): void {
  const code = gameCode.trim().toUpperCase();
  io.to(`hunters_${code}`)
    .to(`game:${code}:hunters`)
    .emit(event, payload);
}

export function emitToRunners(io: AppSocketServer, gameCode: string, event: any, payload: any): void {
  const code = gameCode.trim().toUpperCase();
  io.to(`runners_${code}`)
    .to(`game:${code}:runners`)
    .emit(event, payload);
}

/**
 * Joins a socket into all alias rooms for a game code and role
 */
export function joinAllGameRooms(socket: AppSocket, gameCode: string, role?: PlayerRole): void {
  const code = gameCode.trim().toUpperCase();
  socket.join(`game_${code}`);
  socket.join(`game:${code}`);
  socket.join(code);

  if (role === 'RUNNER') {
    socket.join(`runners_${code}`);
    socket.join(`game:${code}:runners`);
    socket.leave(`hunters_${code}`);
    socket.leave(`game:${code}:hunters`);
  } else if (role === 'HUNTER') {
    socket.join(`hunters_${code}`);
    socket.join(`game:${code}:hunters`);
    socket.leave(`runners_${code}`);
    socket.leave(`game:${code}:runners`);
  }
}

/**
 * Synchronizes both new 'lobby:updated' and authoritative legacy 'game_state_update'
 */
export function broadcastLobbyAndState(io: AppSocketServer, session: GameSession): void {
  const gameManager = GameManager.getInstance();
  const lobbyPlayers = gameManager.getLobbyPlayers(session);
  const legacyState = gameManager.getGameStateLegacy(session);

  emitToGame(io, session.gameCode, 'lobby:updated', { players: lobbyPlayers });
  emitToGame(io, session.gameCode, 'game_state_update', legacyState);
}

export function setupSocketHandlers(io: AppSocketServer): void {
  const gameManager = GameManager.getInstance();

  io.on('connection', (socket: AppSocket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    // 1. CREATE_GAME
    socket.on('create_game', (rawPayload: any, callback: any) => {
      try {
        const payload = Array.isArray(rawPayload) ? (rawPayload[0] || {}) : (rawPayload || {});
        const { session, player } = gameManager.createGame(socket.id, payload);

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = player.playerId || socket.id;
        socket.data.name = player.name;
        socket.data.role = player.role;

        joinAllGameRooms(socket, session.gameCode, player.role);

        console.log(`[Lobby] Game created: "${session.gameCode}" by host "${player.name}"`);

        // Emit to host
        socket.emit('game_created', {
          gameCode: session.gameCode,
          initialCoins: session.runnerCoins,
        });

        // Broadcast to all room variants
        broadcastLobbyAndState(io, session);

        callback?.({
          success: true,
          gameCode: session.gameCode,
          state: gameManager.getGameStateLegacy(session),
        });
      } catch (err) {
        console.error('[Socket.IO] Error in create_game:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 2. JOIN_GAME
    socket.on('join_game', (rawPayload: any, callback: any) => {
      try {
        const payload = Array.isArray(rawPayload) ? (rawPayload[0] || {}) : (rawPayload || {});
        const { session, player } = gameManager.joinGame(socket.id, payload);

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = player.playerId || payload.playerId || socket.id;
        socket.data.name = player.name;
        socket.data.role = player.role;

        joinAllGameRooms(socket, session.gameCode, player.role);

        console.log(`[Lobby] Player "${player.name}" (${player.role}) joined game "${session.gameCode}"`);

        // Notify others
        socket.to(getGameRoom(session.gameCode)).emit('player_joined', player);

        // Broadcast authoritative room state
        broadcastLobbyAndState(io, session);

        callback?.({
          success: true,
          state: gameManager.getGameStateLegacy(session),
        });
      } catch (err) {
        console.error('[Socket.IO] Error in join_game:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 3. PLAYER:TOGGLE_READY
    socket.on('player:toggle_ready', (payload) => {
      try {
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        if (!gameCode) return;

        const result = gameManager.toggleReady(gameCode, socket.id);
        if (result.success && result.session) {
          if (result.autoStarted?.success && result.autoStarted.session && result.autoStarted.runner) {
            const session = result.autoStarted.session;
            const runner = result.autoStarted.runner;
            session.players.forEach((player) => {
              const clientSocket = io.sockets.sockets.get(player.id);
              if (clientSocket) {
                clientSocket.data.role = player.role;
                joinAllGameRooms(clientSocket, session.gameCode, player.role);
              }
            });
            const startedPayload = {
              runnerId: runner.id,
              runnerPlayerId: runner.playerId,
              runnerName: runner.name,
              stage: session.stage,
              jailTimeEndTime: result.autoStarted.jailTimeEndTime!,
            };
            emitToGame(io, session.gameCode, 'game:started', startedPayload);
            emitToGame(io, session.gameCode, 'game_started', startedPayload);
            broadcastLobbyAndState(io, session);
            io.to(runner.id).emit('coins:updated', { coins: session.runnerCoins });
          } else {
            broadcastLobbyAndState(io, result.session);
          }
        }
      } catch (err) {
        console.error('[Socket.IO] Error in player:toggle_ready:', err);
      }
    });

    // 4. PLAYER:TOGGLE_WANTS_RUNNER
    socket.on('player:toggle_wants_runner', (payload) => {
      try {
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        if (!gameCode) return;

        const result = gameManager.toggleWantsRunner(gameCode, socket.id);
        if (result.success && result.session) {
          broadcastLobbyAndState(io, result.session);
        }
      } catch (err) {
        console.error('[Socket.IO] Error in player:toggle_wants_runner:', err);
      }
    });

    // 5. START_GAME (supports start_game & game:start)
    const handleStartGame = (rawPayload: any) => {
      try {
        const payload = Array.isArray(rawPayload) ? (rawPayload[0] || {}) : (rawPayload || {});
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        if (!gameCode) {
          console.warn('[Socket.IO] start_game missing gameCode.');
          return;
        }

        const runnerTarget = payload?.runnerId || payload?.runnerName;
        const result = gameManager.startGame(gameCode, runnerTarget);

        if (!result.success || !result.session || !result.runner) {
          console.warn(`[Socket.IO] Could not start game: ${result.error}`);
          return;
        }

        const session = result.session;

        // Reconfigure socket room memberships based on final assigned roles
        session.players.forEach((player) => {
          const clientSocket = io.sockets.sockets.get(player.id);
          if (clientSocket) {
            clientSocket.data.role = player.role;
            joinAllGameRooms(clientSocket, session.gameCode, player.role);
          }
        });

        console.log(`[Game] Game "${session.gameCode}" started! Designated Runner: "${result.runner.name}"`);

        const startedPayload = {
          runnerId: result.runner.id,
          runnerPlayerId: result.runner.playerId,
          runnerName: result.runner.name,
          stage: session.stage,
          jailTimeEndTime: result.jailTimeEndTime!,
        };

        // Emit both new and legacy started events
        emitToGame(io, session.gameCode, 'game:started', startedPayload);
        emitToGame(io, session.gameCode, 'game_started', startedPayload);

        // Update overall game state
        broadcastLobbyAndState(io, session);

        // Emit initial coins to the runner
        io.to(result.runner.id).emit('coins:updated', {
          coins: session.runnerCoins,
        });
      } catch (err) {
        console.error('[Socket.IO] Error in start_game:', err);
      }
    };

    socket.on('start_game', handleStartGame);
    socket.on('game:start', handleStartGame);

    // 6. TRANSIT_START
    socket.on('transit_start', (payload, callback) => {
      try {
        const result = gameManager.startTransit(socket.id, payload.mode);
        if (!result.success || !result.session) {
          console.warn(`[Transit] Start rejected for socket ${socket.id}: ${result.error}`);
          callback?.({ success: false, error: result.error });
          return;
        }

        emitToGame(io, result.session.gameCode, 'transit_started', result.session.activeTransit);
        emitToGame(io, result.session.gameCode, 'game_state_update', gameManager.getGameStateLegacy(result.session));

        console.log(`[Transit] Runner started "${payload.mode}" in game "${result.session.gameCode}"`);
        callback?.({ success: true, state: gameManager.getGameStateLegacy(result.session) });
      } catch (err) {
        console.error('[Socket.IO] Error in transit_start:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 7. TRANSIT_STOP
    socket.on('transit_stop', (payload, callback) => {
      try {
        const result = gameManager.stopTransit(socket.id);
        if (!result.success || !result.session) {
          console.warn(`[Transit] Stop rejected for socket ${socket.id}: ${result.error}`);
          callback?.({ success: false, error: result.error });
          return;
        }

        const session = result.session;

        // Broadcast updated coin balance & transit stopped report
        emitToGame(io, session.gameCode, 'coins:updated', {
          coins: result.newCoinsBalance!,
        });

        if (result.report) {
          emitToGame(io, session.gameCode, 'transit_stopped', result.report);
        }

        emitToGame(io, session.gameCode, 'game_state_update', gameManager.getGameStateLegacy(session));

        // Overdraft / bankruptcy handling
        if (result.isOverdraft) {
          console.warn(`[Transit] Overdraft in game "${session.gameCode}"! Coins: ${result.newCoinsBalance}`);

          const alertPayload = {
            isSuspect: true,
            reason: `Solde de coins négatif (${result.newCoinsBalance}) après un trajet en ${result.report?.mode || 'transport'}.`,
            coins: result.newCoinsBalance,
            vetoUntil: result.vetoEndTime,
            curse: result.curse,
          };

          emitToGame(io, session.gameCode, 'game:suspect_alert', alertPayload);
          emitToGame(io, session.gameCode, 'suspect_alert', alertPayload);

          if (result.vetoEndTime) {
            emitToGame(io, session.gameCode, 'veto:started', {
              vetoEndTime: result.vetoEndTime,
            });
          }

          if (result.curse) {
            emitToGame(io, session.gameCode, 'runner:curse_triggered', {
              id: result.curse.id,
              title: result.curse.title,
              description: result.curse.description,
              durationMinutes: result.curse.durationMinutes,
            });
          }
        }

        callback?.({
          success: true,
          report: result.report,
          state: gameManager.getGameStateLegacy(session),
        });
      } catch (err) {
        console.error('[Socket.IO] Error in transit_stop:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 8. PING_GPS
    socket.on('ping_gps', (payload, callback) => {
      try {
        if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') {
          callback?.({ success: false, error: 'Coordonnées GPS invalides.' });
          return;
        }

        const result = gameManager.recordGpsPing(socket.id, payload);
        if (!result.success || !result.session) {
          callback?.({ success: false, error: result.error });
          return;
        }

        // If Hunter moved: broadcast updated hunters locations to hunters room
        if (!result.isRunner && result.huntersList) {
          emitToHunters(io, result.session.gameCode, 'hunters:updated', result.huntersList);
        }

        // If Runner moved and broadcast conditions met: broadcast to hunters
        if (result.isRunner && result.broadcastRunnerPing && result.runnerPingPayload) {
          emitToHunters(io, result.session.gameCode, 'runner:last_ping', result.runnerPingPayload);
          emitToHunters(io, result.session.gameCode, 'hunter_ping', result.runnerPingPayload);
        }

        callback?.({ success: true, broadcasted: result.broadcastRunnerPing });
      } catch (err) {
        console.error('[Socket.IO] Error in ping_gps:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 9. HUNTER:ATTEMPT_CAPTURE
    socket.on('hunter:attempt_capture', () => {
      try {
        const result = gameManager.attemptCapture(socket.id);
        if (!result.success || !result.session) return;

        // Threat event sent to entire game room
        emitToGame(io, result.session.gameCode, 'capture:threat', {
          inRange: result.inRange,
          hunterName: result.hunterName,
          distance: result.distance,
        });

        console.log(`[Capture] Attempt by "${result.hunterName}". In range: ${result.inRange} (${result.distance}m)`);
      } catch (err) {
        console.error('[Socket.IO] Error in hunter:attempt_capture:', err);
      }
    });

    // 10. RUNNER:CONFIRM_CAPTURED
    socket.on('runner:confirm_captured', () => {
      try {
        const result = gameManager.confirmCaptured(socket.id);
        if (!result.success || !result.session) return;

        console.log(`[Game] Runner confirmed capture! Game "${result.session.gameCode}" ended.`);

        emitToGame(io, result.session.gameCode, 'game:ended', {
          winner: result.winner || 'HUNTERS',
          history: result.history || [],
        });

        broadcastLobbyAndState(io, result.session);
      } catch (err) {
        console.error('[Socket.IO] Error in runner:confirm_captured:', err);
      }
    });

    // 11. CURSE:ACCEPT
    socket.on('curse:accept', (payload) => {
      try {
        const result = gameManager.acceptCurse(socket.id, payload.coinReward);
        if (result.success && result.session) {
          emitToGame(io, result.session.gameCode, 'coins:updated', {
            coins: result.newCoins!,
          });
          broadcastLobbyAndState(io, result.session);
        }
      } catch (err) {
        console.error('[Socket.IO] Error in curse:accept:', err);
      }
    });

    // 12. CURSE:VETO
    socket.on('curse:veto', (payload) => {
      try {
        const result = gameManager.vetoCurse(socket.id, payload.bonusCoins);
        if (result.success && result.session) {
          if (result.vetoEndTime) {
            emitToGame(io, result.session.gameCode, 'veto:started', {
              vetoEndTime: result.vetoEndTime,
            });
          }
          emitToGame(io, result.session.gameCode, 'coins:updated', {
            coins: result.newCoins!,
          });
          broadcastLobbyAndState(io, result.session);
        }
      } catch (err) {
        console.error('[Socket.IO] Error in curse:veto:', err);
      }
    });

    // 13. EXPORT_GPX
    socket.on('export_gpx', (payload, callback) => {
      try {
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        if (!gameCode) {
          callback?.({ success: false, error: 'gameCode manquant' });
          return;
        }

        const result = gameManager.exportGpx(gameCode);
        if (!result.success || !result.gpx) {
          callback?.({ success: false, error: result.error || 'Erreur GPX' });
          return;
        }

        socket.emit('gpx_exported', {
          gpx: result.gpx,
          filename: result.filename || `game_${gameCode}.gpx`,
        });

        callback?.({ success: true, gpx: result.gpx });
      } catch (err) {
        console.error('[Socket.IO] Error in export_gpx:', err);
        callback?.({ success: false, error: String(err) });
      }
    });

    // 14. FINAL RUN ACTIVATION (Hunters at 1h30)
    socket.on('game:final_run', (rawPayload: any) => {
      try {
        const payload = Array.isArray(rawPayload) ? (rawPayload[0] || {}) : (rawPayload || {});
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        const powerType = payload?.powerType || 'MEGA_RADAR';
        if (!gameCode) return;

        const durationMinutes = 10;
        const endsAt = Date.now() + durationMinutes * 60 * 1000;

        console.log(`[FinalRun] Activated "${powerType}" in game "${gameCode}" for 10 min!`);

        emitToGame(io, gameCode, 'game:final_run_activated', {
          powerType,
          endsAt,
          durationMinutes,
        });
        emitToGame(io, gameCode, 'final_run:activated', {
          powerType,
          endsAt,
          durationMinutes,
        });
      } catch (err) {
        console.error('[Socket.IO] Error in game:final_run:', err);
      }
    });

    // 15. ABANDON GAME
    socket.on('game:abandon', (rawPayload: any) => {
      try {
        const payload = Array.isArray(rawPayload) ? (rawPayload[0] || {}) : (rawPayload || {});
        const gameCode = payload?.gameCode || payload?.gameId || socket.data.gameCode;
        if (!gameCode) return;

        console.log(`[Game] Game "${gameCode}" abandoned by client ${socket.id}`);
        emitToGame(io, gameCode, 'game:ended', { winner: 'ABANDONED' });
      } catch (err) {
        console.error('[Socket.IO] Error in game:abandon:', err);
      }
    });

    // 16. DISCONNECT
    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (reason: ${reason})`);
      const { session } = gameManager.removePlayer(socket.id);
      if (session) {
        // Player is preserved with lastSeen timestamp so reconnect works!
        broadcastLobbyAndState(io, session);
      }
    });
  });
}
