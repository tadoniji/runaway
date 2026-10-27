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
export const getGameRoom = (gameCode: string) => `game_${gameCode.toUpperCase()}`;
export const getHunterRoom = (gameCode: string) => `hunters_${gameCode.toUpperCase()}`;
export const getRunnerRoom = (gameCode: string) => `runners_${gameCode.toUpperCase()}`;

export function setupSocketHandlers(io: AppSocketServer): void {
  const gameManager = GameManager.getInstance();

  io.on('connection', (socket: AppSocket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    // 1. CREATE_GAME
    socket.on('create_game', (payload) => {
      try {
        const { session, player } = gameManager.createGame(socket.id, payload);
        const gameRoom = getGameRoom(session.gameCode);

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = socket.id;
        socket.data.name = player.name;
        socket.data.role = player.role;

        socket.join(gameRoom);
        if (player.role === 'RUNNER') {
          socket.join(getRunnerRoom(session.gameCode));
        }

        console.log(`[Lobby] Game created: "${session.gameCode}" by "${player.name}"`);

        // Emit to host
        socket.emit('game_created', {
          gameCode: session.gameCode,
          initialCoins: session.runnerCoins,
        });

        // Broadcast updated lobby
        io.to(gameRoom).emit('lobby:updated', {
          players: gameManager.getLobbyPlayers(session),
        });
      } catch (err) {
        console.error('[Socket.IO] Error in create_game:', err);
      }
    });

    // 2. JOIN_GAME
    socket.on('join_game', (payload) => {
      try {
        const { session, player } = gameManager.joinGame(socket.id, payload);
        const gameRoom = getGameRoom(session.gameCode);

        socket.data.gameCode = session.gameCode;
        socket.data.playerId = payload.playerId || socket.id;
        socket.data.name = player.name;
        socket.data.role = player.role;

        socket.join(gameRoom);

        if (player.role === 'RUNNER') {
          socket.join(getRunnerRoom(session.gameCode));
        } else if (player.role === 'HUNTER') {
          socket.join(getHunterRoom(session.gameCode));
        }

        console.log(`[Lobby] Player "${player.name}" joined game "${session.gameCode}"`);

        io.to(gameRoom).emit('lobby:updated', {
          players: gameManager.getLobbyPlayers(session),
        });
      } catch (err) {
        console.error('[Socket.IO] Error in join_game:', err);
      }
    });

    // 3. PLAYER:TOGGLE_READY
    socket.on('player:toggle_ready', (payload) => {
      try {
        const result = gameManager.toggleReady(payload.gameCode, socket.id);
        if (result.success && result.session) {
          const gameRoom = getGameRoom(result.session.gameCode);
          io.to(gameRoom).emit('lobby:updated', {
            players: gameManager.getLobbyPlayers(result.session),
          });
        }
      } catch (err) {
        console.error('[Socket.IO] Error in player:toggle_ready:', err);
      }
    });

    // 4. PLAYER:TOGGLE_WANTS_RUNNER
    socket.on('player:toggle_wants_runner', (payload) => {
      try {
        const result = gameManager.toggleWantsRunner(payload.gameCode, socket.id);
        if (result.success && result.session) {
          const gameRoom = getGameRoom(result.session.gameCode);
          io.to(gameRoom).emit('lobby:updated', {
            players: gameManager.getLobbyPlayers(result.session),
          });
        }
      } catch (err) {
        console.error('[Socket.IO] Error in player:toggle_wants_runner:', err);
      }
    });

    // 5. START_GAME
    socket.on('start_game', (payload) => {
      try {
        const result = gameManager.startGame(payload.gameCode);
        if (!result.success || !result.session || !result.runner) {
          console.warn(`[Socket.IO] Could not start game: ${result.error}`);
          return;
        }

        const session = result.session;
        const gameRoom = getGameRoom(session.gameCode);
        const hunterRoom = getHunterRoom(session.gameCode);
        const runnerRoom = getRunnerRoom(session.gameCode);

        // Update socket room memberships based on final assigned roles
        session.players.forEach((player) => {
          const clientSocket = io.sockets.sockets.get(player.id);
          if (clientSocket) {
            clientSocket.data.role = player.role;
            if (player.role === 'RUNNER') {
              clientSocket.join(runnerRoom);
              clientSocket.leave(hunterRoom);
            } else {
              clientSocket.join(hunterRoom);
              clientSocket.leave(runnerRoom);
            }
          }
        });

        console.log(`[Game] Game "${session.gameCode}" started! Runner: "${result.runner.name}"`);

        io.to(gameRoom).emit('game:started', {
          runnerId: result.runner.id,
          stage: session.stage,
          jailTimeEndTime: result.jailTimeEndTime!,
        });

        // Emit initial coins to the runner
        io.to(result.runner.id).emit('coins:updated', {
          coins: session.runnerCoins,
        });
      } catch (err) {
        console.error('[Socket.IO] Error in start_game:', err);
      }
    });

    // 6. TRANSIT_START
    socket.on('transit_start', (payload) => {
      try {
        const result = gameManager.startTransit(socket.id, payload.mode);
        if (!result.success) {
          console.warn(`[Transit] Start rejected for socket ${socket.id}: ${result.error}`);
          return;
        }
        console.log(`[Transit] Started mode "${payload.mode}" for runner ${socket.id}`);
      } catch (err) {
        console.error('[Socket.IO] Error in transit_start:', err);
      }
    });

    // 7. TRANSIT_STOP
    socket.on('transit_stop', () => {
      try {
        const result = gameManager.stopTransit(socket.id);
        if (!result.success || !result.session) {
          console.warn(`[Transit] Stop rejected for socket ${socket.id}: ${result.error}`);
          return;
        }

        const session = result.session;
        const gameRoom = getGameRoom(session.gameCode);

        // Broadcast updated coin balance
        io.to(gameRoom).emit('coins:updated', {
          coins: result.newCoinsBalance!,
        });

        // Overdraft / bankruptcy handling
        if (result.isOverdraft) {
          console.warn(`[Transit] Overdraft in game "${session.gameCode}"! Coins: ${result.newCoinsBalance}`);

          io.to(gameRoom).emit('game:suspect_alert', {
            isSuspect: true,
            reason: 'Solde de coins négatif après un trajet en transport.',
          });

          if (result.vetoEndTime) {
            io.to(gameRoom).emit('veto:started', {
              vetoEndTime: result.vetoEndTime,
            });
          }

          if (result.curse) {
            io.to(gameRoom).emit('runner:curse_triggered', {
              id: result.curse.id,
              title: result.curse.title,
              description: result.curse.description,
              durationMinutes: result.curse.durationMinutes,
            });
          }
        }
      } catch (err) {
        console.error('[Socket.IO] Error in transit_stop:', err);
      }
    });

    // 8. PING_GPS
    socket.on('ping_gps', (payload) => {
      try {
        if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') {
          return;
        }

        const result = gameManager.recordGpsPing(socket.id, payload);
        if (!result.success || !result.session) return;

        const hunterRoom = getHunterRoom(result.session.gameCode);

        // If Hunter moved: broadcast updated hunters locations
        if (!result.isRunner && result.huntersList) {
          io.to(hunterRoom).emit('hunters:updated', result.huntersList);
        }

        // If Runner moved and broadcast conditions met: broadcast to hunters
        if (result.isRunner && result.broadcastRunnerPing && result.runnerPingPayload) {
          io.to(hunterRoom).emit('runner:last_ping', result.runnerPingPayload);
        }
      } catch (err) {
        console.error('[Socket.IO] Error in ping_gps:', err);
      }
    });

    // 9. HUNTER:ATTEMPT_CAPTURE
    socket.on('hunter:attempt_capture', () => {
      try {
        const result = gameManager.attemptCapture(socket.id);
        if (!result.success || !result.session) return;

        const gameRoom = getGameRoom(result.session.gameCode);

        // Threat event sent to runner (or game room)
        io.to(gameRoom).emit('capture:threat', {
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

        const gameRoom = getGameRoom(result.session.gameCode);
        console.log(`[Game] Runner confirmed capture! Game "${result.session.gameCode}" ended.`);

        io.to(gameRoom).emit('game:ended', {
          winner: result.winner || 'HUNTERS',
          history: result.history || [],
        });
      } catch (err) {
        console.error('[Socket.IO] Error in runner:confirm_captured:', err);
      }
    });

    // 11. CURSE:ACCEPT
    socket.on('curse:accept', (payload) => {
      try {
        const result = gameManager.acceptCurse(socket.id, payload.coinReward);
        if (result.success && result.session) {
          const gameRoom = getGameRoom(result.session.gameCode);
          io.to(gameRoom).emit('coins:updated', {
            coins: result.newCoins!,
          });
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
          const gameRoom = getGameRoom(result.session.gameCode);
          if (result.vetoEndTime) {
            io.to(gameRoom).emit('veto:started', {
              vetoEndTime: result.vetoEndTime,
            });
          }
          io.to(gameRoom).emit('coins:updated', {
            coins: result.newCoins!,
          });
        }
      } catch (err) {
        console.error('[Socket.IO] Error in curse:veto:', err);
      }
    });

    // DISCONNECT
    socket.on('disconnect', (reason) => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id} (reason: ${reason})`);
      const { session, removedPlayer } = gameManager.removePlayer(socket.id);
      if (session && removedPlayer) {
        const gameRoom = getGameRoom(session.gameCode);
        io.to(gameRoom).emit('lobby:updated', {
          players: gameManager.getLobbyPlayers(session),
        });
      }
    });
  });
}
