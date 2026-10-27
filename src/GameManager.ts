import { randomUUID } from 'crypto';
import {
  Curse,
  GameState,
  GpsPoint,
  HunterPing,
  Player,
  PlayerRole,
  TransitMode,
  TransitReport,
} from './types';
import {
  CURSE_POOL,
  HUNTER_PING_INTERVAL_MS,
  INITIAL_COINS,
  TRANSIT_RATES,
  VETO_DURATION_MS,
} from './constants';
import { generateGpx } from './utils/gpxGenerator';

/**
 * Singleton authoritative GameManager
 * Manages game sessions, transit timers, coins balance, vetoes, and GPS tracking.
 */
export class GameManager {
  private static instance: GameManager;
  private games: Map<string, GameState> = new Map();
  // Reverse lookup: socketId -> gameId
  private socketToGame: Map<string, string> = new Map();

  private constructor() {}

  public static getInstance(): GameManager {
    if (!GameManager.instance) {
      GameManager.instance = new GameManager();
    }
    return GameManager.instance;
  }

  /**
   * Returns an existing game or initializes a new authoritative session
   */
  public getOrCreateGame(gameId: string): GameState {
    const existing = this.games.get(gameId);
    if (existing) {
      this.checkAndExpirePenalties(existing);
      return existing;
    }

    const now = Date.now();
    const newGame: GameState = {
      gameId,
      coins: INITIAL_COINS,
      status: 'NORMAL',
      activeTransit: null,
      activeVetoUntil: null,
      activeCurse: null,
      history: [],
      lastHunterPing: null,
      players: {},
      createdAt: now,
      updatedAt: now,
    };

    this.games.set(gameId, newGame);
    return newGame;
  }

  /**
   * Retrieves an existing game without automatic creation
   */
  public getGame(gameId: string): GameState | undefined {
    const game = this.games.get(gameId);
    if (game) {
      this.checkAndExpirePenalties(game);
    }
    return game;
  }

  /**
   * Finds the game associated with a socket ID
   */
  public getGameBySocketId(socketId: string): GameState | undefined {
    const gameId = this.socketToGame.get(socketId);
    return gameId ? this.getGame(gameId) : undefined;
  }

  /**
   * Adds or updates a player in a game room
   */
  public addPlayer(
    gameId: string,
    playerInfo: { id: string; role: PlayerRole; name: string }
  ): { game: GameState; player: Player } {
    const game = this.getOrCreateGame(gameId);

    const player: Player = {
      id: playerInfo.id,
      role: playerInfo.role,
      name: playerInfo.name.trim() || `Player_${playerInfo.id.slice(0, 4)}`,
      joinedAt: Date.now(),
    };

    game.players[player.id] = player;
    game.updatedAt = Date.now();
    this.socketToGame.set(player.id, gameId);

    return { game, player };
  }

  /**
   * Handles player disconnection and room cleanup
   */
  public removePlayer(socketId: string): { game?: GameState; removedPlayer?: Player } {
    const gameId = this.socketToGame.get(socketId);
    if (!gameId) return {};

    this.socketToGame.delete(socketId);
    const game = this.games.get(gameId);
    if (!game) return {};

    const removedPlayer = game.players[socketId];
    if (removedPlayer) {
      delete game.players[socketId];
      game.updatedAt = Date.now();
    }

    return { game, removedPlayer };
  }

  /**
   * Start a transit session for the runner
   * Authoritative checks:
   * 1. Player is RUNNER
   * 2. Coins > 0
   * 3. No active veto (activeVetoUntil < Date.now())
   * 4. No transit already running
   */
  public startTransit(
    gameId: string,
    playerId: string,
    mode: TransitMode
  ): { success: boolean; game?: GameState; error?: string } {
    const game = this.getGame(gameId);
    if (!game) {
      return { success: false, error: `Partie ${gameId} introuvable.` };
    }

    const player = game.players[playerId];
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner est autorisé à démarrer un transit.' };
    }

    if (game.activeTransit) {
      return {
        success: false,
        error: `Un transit en mode "${game.activeTransit.mode}" est déjà en cours.`,
      };
    }

    if (game.coins <= 0) {
      return {
        success: false,
        error: `Solde insuffisant (${game.coins} coins). Vous ne pouvez pas démarrer de transport.`,
      };
    }

    const now = Date.now();
    if (game.activeVetoUntil && game.activeVetoUntil > now) {
      const remainingSeconds = Math.ceil((game.activeVetoUntil - now) / 1000);
      const remainingMinutes = Math.ceil(remainingSeconds / 60);
      return {
        success: false,
        error: `Véto en cours ! Déplacement en transport interdit pour encore ${remainingMinutes} min (${remainingSeconds}s).`,
      };
    }

    if (!TRANSIT_RATES[mode]) {
      return { success: false, error: `Mode de transit inconnu : ${mode}` };
    }

    game.activeTransit = {
      mode,
      startTime: now,
    };
    game.updatedAt = now;

    return { success: true, game };
  }

  /**
   * Stops an active transit session
   * Calculates elapsed minutes, applies transit rate, deduces coins.
   * If coins < 0:
   * - Immediately applies a random Curse
   * - Sets a 20-minute active veto (activeVetoUntil = Date.now() + 20 * 60 * 1000)
   * - Switches game status to 'SUSPECT'
   */
  public stopTransit(
    gameId: string,
    playerId: string
  ): {
    success: boolean;
    game?: GameState;
    report?: TransitReport;
    error?: string;
  } {
    const game = this.getGame(gameId);
    if (!game) {
      return { success: false, error: `Partie ${gameId} introuvable.` };
    }

    const player = game.players[playerId];
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut arrêter son transit.' };
    }

    if (!game.activeTransit) {
      return { success: false, error: 'Aucun transit actif à arrêter.' };
    }

    const now = Date.now();
    const { mode, startTime } = game.activeTransit;
    const elapsedMs = Math.max(0, now - startTime);
    const durationSeconds = Math.round(elapsedMs / 1000);
    const durationMinutes = elapsedMs / 60000;

    const rate = TRANSIT_RATES[mode];
    // Exact cost rounded up to the nearest integer so fractions of minutes are fairly accounted for
    const coinsDeducted = Math.ceil(durationMinutes * rate);

    game.coins -= coinsDeducted;
    game.activeTransit = null;
    game.updatedAt = now;

    let penaltiesApplied = false;
    let appliedCurse: Curse | undefined;
    let vetoUntil: number | undefined;

    // Overdraft penalty check
    if (game.coins < 0) {
      penaltiesApplied = true;
      const curseTemplate = CURSE_POOL[Math.floor(Math.random() * CURSE_POOL.length)];
      appliedCurse = {
        id: randomUUID(),
        type: curseTemplate.type,
        name: curseTemplate.name,
        description: curseTemplate.description,
        appliedAt: now,
        durationMs: curseTemplate.durationMs,
      };

      vetoUntil = now + VETO_DURATION_MS;

      game.activeCurse = appliedCurse;
      game.activeVetoUntil = vetoUntil;
      game.status = 'SUSPECT';
    }

    const report: TransitReport = {
      mode,
      startTime,
      endTime: now,
      durationSeconds,
      durationMinutes: parseFloat(durationMinutes.toFixed(2)),
      ratePerMinute: rate,
      coinsDeducted,
      newCoinsBalance: game.coins,
      penaltiesApplied,
      curseApplied: appliedCurse,
      vetoUntil,
    };

    return {
      success: true,
      game,
      report,
    };
  }

  /**
   * Records a GPS ping from the Runner.
   * - Appends to full history (for GPX export).
   * - Checks whether to broadcast location to Hunters:
   *   * Periodic interval (10 min) has elapsed since lastHunterPing
   *   * OR activeCurse is 'SONAR' (forces immediate broadcast)
   */
  public recordGpsPing(
    gameId: string,
    playerId: string,
    data: { lat: number; lng: number; altitude?: number; speed?: number }
  ): {
    success: boolean;
    broadcastToHunters: boolean;
    ping?: HunterPing;
    error?: string;
  } {
    const game = this.getGame(gameId);
    if (!game) {
      return { success: false, broadcastToHunters: false, error: `Partie ${gameId} introuvable.` };
    }

    const player = game.players[playerId];
    if (!player || player.role !== 'RUNNER') {
      return {
        success: false,
        broadcastToHunters: false,
        error: 'Seul le Runner envoie des pings GPS de position.',
      };
    }

    const now = Date.now();
    const gpsPoint: GpsPoint = {
      lat: data.lat,
      lng: data.lng,
      timestamp: now,
      mode: game.activeTransit?.mode,
      altitude: data.altitude,
      speed: data.speed,
    };

    // Always record full path for GPX export
    game.history.push(gpsPoint);
    game.updatedAt = now;

    // Check conditions for sending location to Hunters
    const isSonarActive = game.activeCurse?.type === 'SONAR';
    const isPeriodicDue =
      !game.lastHunterPing ||
      now - game.lastHunterPing.timestamp >= HUNTER_PING_INTERVAL_MS;

    if (isSonarActive || isPeriodicDue) {
      const triggerReason: HunterPing['triggerReason'] = isSonarActive
        ? 'SONAR_CURSE'
        : 'PERIODIC';

      const ping: HunterPing = {
        lat: data.lat,
        lng: data.lng,
        timestamp: now,
        triggerReason,
      };

      game.lastHunterPing = ping;

      return {
        success: true,
        broadcastToHunters: true,
        ping,
      };
    }

    return {
      success: true,
      broadcastToHunters: false,
    };
  }

  /**
   * Exports GPX string from game history
   */
  public exportGpx(gameId: string): { success: boolean; gpx?: string; filename?: string; error?: string } {
    const game = this.getGame(gameId);
    if (!game) {
      return { success: false, error: `Partie ${gameId} introuvable.` };
    }

    const gpx = generateGpx(gameId, game.history);
    const filename = `runaway_${gameId}_${Date.now()}.gpx`;

    return {
      success: true,
      gpx,
      filename,
    };
  }

  /**
   * Helper to check and reset expired vetoes or curses
   */
  private checkAndExpirePenalties(game: GameState): void {
    const now = Date.now();

    // Check veto expiration
    if (game.activeVetoUntil && now >= game.activeVetoUntil) {
      game.activeVetoUntil = null;
      // If no active transit and veto finished, reset suspect if coins >= 0
      if (game.coins >= 0) {
        game.status = 'NORMAL';
      }
    }

    // Check curse expiration
    if (game.activeCurse?.durationMs) {
      if (now >= game.activeCurse.appliedAt + game.activeCurse.durationMs) {
        game.activeCurse = null;
      }
    }
  }

  /**
   * Returns all active game IDs
   */
  public listGames(): string[] {
    return Array.from(this.games.keys());
  }

  /**
   * Clear all games (useful for testing)
   */
  public clearAll(): void {
    this.games.clear();
    this.socketToGame.clear();
  }
}
