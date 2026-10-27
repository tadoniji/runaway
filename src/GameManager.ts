import { randomUUID } from 'crypto';
import {
  ActiveCurse,
  GamePhase,
  GameSession,
  GameSessionDTO,
  GameSettings,
  HunterPing,
  Player,
  PlayerRole,
  PositionPoint,
  TransitReport,
} from './types';
import {
  CURSE_TEMPLATES,
  DEFAULT_SETTINGS,
  INITIAL_RUNNER_COINS,
} from './constants';
import { computeDistanceMeters } from './utils/geo';
import { generateGpx } from './utils/gpxGenerator';

/**
 * Singleton authoritative GameManager
 * Manages game sessions, state machines (phases), transit timers, coins, and proximity detection.
 */
export class GameManager {
  private static instance: GameManager;
  private sessions: Map<string, GameSession> = new Map();
  // Reverse lookup: socketId -> gameCode
  private socketToGame: Map<string, string> = new Map();

  private constructor() {}

  public static getInstance(): GameManager {
    if (!GameManager.instance) {
      GameManager.instance = new GameManager();
    }
    return GameManager.instance;
  }

  /**
   * Generates a unique 6-character uppercase alphanumeric game code
   */
  public generateGameCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.sessions.has(code));
    return code;
  }

  /**
   * Helper to serialize GameSession (converts Map<string, Player> to Record<string, Player>)
   */
  public serializeSession(session: GameSession): GameSessionDTO {
    const playersRecord: Record<string, Player> = {};
    session.players.forEach((player, id) => {
      playersRecord[id] = player;
    });

    return {
      gameCode: session.gameCode,
      hostId: session.hostId,
      phase: session.phase,
      settings: session.settings,
      players: playersRecord,
      runnerId: session.runnerId,
      runnerCoins: session.runnerCoins,
      activeTransit: session.activeTransit,
      activeVetoUntil: session.activeVetoUntil,
      activeCurses: session.activeCurses,
      jailTimeEndsAt: session.jailTimeEndsAt,
      lastRunnerPingSentAt: session.lastRunnerPingSentAt,
      captureCandidateHunterId: session.captureCandidateHunterId,
      positionsHistory: session.positionsHistory,
    };
  }

  /**
   * Creates a brand new game session in LOBBY phase
   */
  public createGame(
    hostId: string,
    hostName: string,
    avatarUrl: string | null = null,
    wantsRunner = false,
    customSettings?: Partial<GameSettings>
  ): GameSession {
    const gameCode = this.generateGameCode();
    const now = Date.now();

    const settings: GameSettings = {
      ...DEFAULT_SETTINGS,
      ...customSettings,
      transportRates: {
        ...DEFAULT_SETTINGS.transportRates,
        ...(customSettings?.transportRates || {}),
      },
    };

    const hostPlayer: Player = {
      id: hostId,
      name: hostName.trim() || 'Host',
      role: wantsRunner ? 'RUNNER' : 'UNDECIDED',
      wantsRunner,
      isReady: true,
      avatarUrl: avatarUrl || null,
      lat: 0,
      lng: 0,
      lastSeen: now,
    };

    const playersMap = new Map<string, Player>();
    playersMap.set(hostId, hostPlayer);

    const session: GameSession = {
      gameCode,
      hostId,
      phase: 'LOBBY',
      settings,
      players: playersMap,
      runnerId: wantsRunner ? hostId : null,
      runnerCoins: INITIAL_RUNNER_COINS,
      activeTransit: null,
      activeVetoUntil: null,
      activeCurses: [],
      jailTimeEndsAt: null,
      lastRunnerPingSentAt: null,
      captureCandidateHunterId: null,
      positionsHistory: [],
    };

    this.sessions.set(gameCode, session);
    this.socketToGame.set(hostId, gameCode);

    return session;
  }

  /**
   * Returns an existing session or initializes a fallback session for backward compatibility
   */
  public getOrCreateSession(gameCode: string, hostId?: string): GameSession {
    const normalizedCode = gameCode.trim().toUpperCase();
    let session = this.sessions.get(normalizedCode);

    if (session) {
      this.checkPhaseAndPenalties(session);
      return session;
    }

    const fallbackHostId = hostId || 'host_' + randomUUID().slice(0, 8);
    session = {
      gameCode: normalizedCode,
      hostId: fallbackHostId,
      phase: 'LOBBY',
      settings: {
        ...DEFAULT_SETTINGS,
        transportRates: { ...DEFAULT_SETTINGS.transportRates },
      },
      players: new Map<string, Player>(),
      runnerId: null,
      runnerCoins: INITIAL_RUNNER_COINS,
      activeTransit: null,
      activeVetoUntil: null,
      activeCurses: [],
      jailTimeEndsAt: null,
      lastRunnerPingSentAt: null,
      captureCandidateHunterId: null,
      positionsHistory: [],
    };

    this.sessions.set(normalizedCode, session);
    return session;
  }

  /**
   * Retrieves an existing game session
   */
  public getSession(gameCode: string): GameSession | undefined {
    const normalizedCode = gameCode.trim().toUpperCase();
    const session = this.sessions.get(normalizedCode);
    if (session) {
      this.checkPhaseAndPenalties(session);
    }
    return session;
  }

  /**
   * Finds the session associated with a socket ID
   */
  public getSessionBySocketId(socketId: string): GameSession | undefined {
    const gameCode = this.socketToGame.get(socketId);
    return gameCode ? this.getSession(gameCode) : undefined;
  }

  /**
   * Adds or updates a player in a game session
   */
  public addPlayer(
    gameCode: string,
    playerInfo: {
      id: string;
      name: string;
      avatarUrl?: string | null;
      wantsRunner?: boolean;
      role?: PlayerRole;
    }
  ): { session: GameSession; player: Player } {
    const session = this.getOrCreateSession(gameCode, playerInfo.id);
    const now = Date.now();

    const assignedRole: PlayerRole =
      playerInfo.role ||
      (playerInfo.wantsRunner ? 'RUNNER' : 'UNDECIDED');

    const player: Player = {
      id: playerInfo.id,
      name: playerInfo.name.trim() || `Player_${playerInfo.id.slice(0, 4)}`,
      role: assignedRole,
      wantsRunner: playerInfo.wantsRunner ?? false,
      isReady: false,
      avatarUrl: playerInfo.avatarUrl || null,
      lat: 0,
      lng: 0,
      lastSeen: now,
    };

    session.players.set(player.id, player);
    this.socketToGame.set(player.id, session.gameCode);

    if (assignedRole === 'RUNNER' && !session.runnerId) {
      session.runnerId = player.id;
    }

    return { session, player };
  }

  /**
   * Handles player disconnection
   */
  public removePlayer(socketId: string): { session?: GameSession; removedPlayer?: Player } {
    const gameCode = this.socketToGame.get(socketId);
    if (!gameCode) return {};

    this.socketToGame.delete(socketId);
    const session = this.sessions.get(gameCode);
    if (!session) return {};

    const removedPlayer = session.players.get(socketId);
    if (removedPlayer) {
      session.players.delete(socketId);
      if (session.runnerId === socketId) {
        session.runnerId = null;
      }
      if (session.captureCandidateHunterId === socketId) {
        session.captureCandidateHunterId = null;
      }
    }

    return { session, removedPlayer };
  }

  /**
   * Toggles player readiness in the lobby
   */
  public setPlayerReady(
    gameCode: string,
    playerId: string,
    isReady: boolean
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(playerId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };

    player.isReady = isReady;
    return { success: true, session };
  }

  /**
   * Toggles player runner volunteer status
   */
  public setWantsRunner(
    gameCode: string,
    playerId: string,
    wantsRunner: boolean
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(playerId);
    if (!player) return { success: false, error: 'Joueur introuvable.' };

    player.wantsRunner = wantsRunner;
    return { success: true, session };
  }

  /**
   * Assigns a role to a specific player (Host only)
   */
  public assignRole(
    gameCode: string,
    requesterId: string,
    targetPlayerId: string,
    role: PlayerRole
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    if (session.hostId !== requesterId) {
      return { success: false, error: 'Seul l\'hôte peut assigner les rôles.' };
    }

    const target = session.players.get(targetPlayerId);
    if (!target) return { success: false, error: 'Joueur cible introuvable.' };

    if (role === 'RUNNER') {
      // Clear previous runner
      session.players.forEach((p) => {
        if (p.role === 'RUNNER') p.role = 'HUNTER';
      });
      target.role = 'RUNNER';
      session.runnerId = targetPlayerId;
    } else {
      target.role = role;
      if (session.runnerId === targetPlayerId) {
        session.runnerId = null;
      }
    }

    return { success: true, session };
  }

  /**
   * Updates game settings (Host only)
   */
  public updateSettings(
    gameCode: string,
    requesterId: string,
    newSettings: Partial<GameSettings>
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    if (session.hostId !== requesterId) {
      return { success: false, error: 'Seul l\'hôte peut modifier les paramètres.' };
    }

    if (session.phase !== 'LOBBY') {
      return { success: false, error: 'Les paramètres ne peuvent être modifiés que dans le Lobby.' };
    }

    session.settings = {
      ...session.settings,
      ...newSettings,
      transportRates: {
        ...session.settings.transportRates,
        ...(newSettings.transportRates || {}),
      },
    };

    return { success: true, session };
  }

  /**
   * Starts the game: assigns Runner, transitions to JAIL_TIME or ACTIVE
   */
  public startGame(
    gameCode: string,
    requesterId: string
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    if (session.hostId !== requesterId) {
      return { success: false, error: 'Seul l\'hôte peut démarrer la partie.' };
    }

    if (session.phase !== 'LOBBY') {
      return { success: false, error: `La partie est déjà en phase "${session.phase}".` };
    }

    // Determine Runner
    if (!session.runnerId || !session.players.has(session.runnerId)) {
      const candidates = Array.from(session.players.values()).filter((p) => p.wantsRunner);
      const chosen =
        candidates.length > 0
          ? candidates[Math.floor(Math.random() * candidates.length)]
          : Array.from(session.players.values())[0];

      if (!chosen) {
        return { success: false, error: 'Impossible de démarrer sans joueur.' };
      }

      session.runnerId = chosen.id;
    }

    // Assign final roles
    session.players.forEach((player) => {
      if (player.id === session.runnerId) {
        player.role = 'RUNNER';
      } else {
        player.role = 'HUNTER';
      }
    });

    const now = Date.now();
    const jailDurationMinutes = session.settings.jailTimeMinutes || 0;

    if (jailDurationMinutes > 0) {
      session.phase = 'JAIL_TIME';
      session.jailTimeEndsAt = now + jailDurationMinutes * 60 * 1000;
    } else {
      session.phase = 'ACTIVE';
      session.jailTimeEndsAt = null;
    }

    session.runnerCoins = INITIAL_RUNNER_COINS;
    session.activeTransit = null;
    session.activeVetoUntil = null;
    session.activeCurses = [];
    session.lastRunnerPingSentAt = null;
    session.captureCandidateHunterId = null;

    return { success: true, session };
  }

  /**
   * Authoritative Transit Start
   */
  public startTransit(
    gameCode: string,
    playerId: string,
    mode: string
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    if (session.phase !== 'ACTIVE' && session.phase !== 'JAIL_TIME') {
      return { success: false, error: `Les transports sont indisponibles en phase "${session.phase}".` };
    }

    const player = session.players.get(playerId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut démarrer un transport.' };
    }

    if (session.activeTransit) {
      return { success: false, error: `Un transit en mode "${session.activeTransit.mode}" est déjà en cours.` };
    }

    if (session.runnerCoins <= 0) {
      return { success: false, error: `Solde insuffisant (${session.runnerCoins} coins).` };
    }

    const now = Date.now();
    if (session.activeVetoUntil && session.activeVetoUntil > now) {
      const remainingSeconds = Math.ceil((session.activeVetoUntil - now) / 1000);
      return { success: false, error: `Véto actif pour encore ${remainingSeconds}s.` };
    }

    const rate = session.settings.transportRates[mode];
    if (rate === undefined) {
      return { success: false, error: `Mode de transport inconnu : "${mode}".` };
    }

    session.activeTransit = {
      mode,
      startTimestamp: now,
    };

    return { success: true, session };
  }

  /**
   * Authoritative Transit Stop & Overdraft Calculation
   */
  public stopTransit(
    gameCode: string,
    playerId: string
  ): { success: boolean; session?: GameSession; report?: TransitReport; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(playerId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut arrêter son transport.' };
    }

    if (!session.activeTransit) {
      return { success: false, error: 'Aucun transit actif à arrêter.' };
    }

    const now = Date.now();
    const { mode, startTimestamp } = session.activeTransit;
    const elapsedMs = Math.max(0, now - startTimestamp);
    const durationSeconds = Math.round(elapsedMs / 1000);
    const durationMinutes = durationSeconds / 60;

    const rate = session.settings.transportRates[mode] ?? 15;
    const coinsDeducted = Math.ceil(durationMinutes * rate);

    session.runnerCoins -= coinsDeducted;
    session.activeTransit = null;

    let penaltiesApplied = false;
    let appliedCurse: ActiveCurse | undefined;
    let vetoUntil: number | undefined;

    // Overdraft check
    if (session.runnerCoins < 0) {
      penaltiesApplied = true;
      const curseTemplate = CURSE_TEMPLATES[Math.floor(Math.random() * CURSE_TEMPLATES.length)];
      appliedCurse = {
        id: randomUUID(),
        title: curseTemplate.title,
        description: curseTemplate.description,
        coinReward: curseTemplate.coinReward,
        type: curseTemplate.type,
        appliedAt: now,
        durationMs: curseTemplate.durationMs,
      };

      const vetoMs = (session.settings.vetoDurationMinutes || 20) * 60 * 1000;
      vetoUntil = now + vetoMs;

      session.activeCurses.push(appliedCurse);
      session.activeVetoUntil = vetoUntil;
    }

    const report: TransitReport = {
      mode,
      startTimestamp,
      endTimestamp: now,
      durationSeconds,
      durationMinutes: parseFloat(durationMinutes.toFixed(2)),
      ratePerMinute: rate,
      coinsDeducted,
      newCoinsBalance: session.runnerCoins,
      penaltiesApplied,
      curseApplied: appliedCurse,
      vetoUntil,
    };

    return { success: true, session, report };
  }

  /**
   * Records GPS Position and evaluates proximity / capture opportunities
   */
  public recordPosition(
    gameCode: string,
    playerId: string,
    data: { lat: number; lng: number; altitude?: number; speed?: number }
  ): {
    success: boolean;
    session?: GameSession;
    broadcastToHunters: boolean;
    ping?: HunterPing;
    distanceToRunner?: number;
    captureOpportunity?: boolean;
    error?: string;
  } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, broadcastToHunters: false, error: 'Session introuvable.' };

    const player = session.players.get(playerId);
    if (!player) return { success: false, broadcastToHunters: false, error: 'Joueur introuvable.' };

    const now = Date.now();
    player.lat = data.lat;
    player.lng = data.lng;
    player.lastSeen = now;

    // Append to authoritative position history
    const posPoint: PositionPoint = {
      playerId,
      role: player.role,
      lat: data.lat,
      lng: data.lng,
      timestamp: now,
      mode: session.activeTransit?.mode,
      altitude: data.altitude,
      speed: data.speed,
    };
    session.positionsHistory.push(posPoint);

    // If Runner moved
    if (player.role === 'RUNNER') {
      const isSonarActive = session.activeCurses.some((c) => c.type === 'SONAR');
      const pingIntervalMs = (session.settings.pingIntervalMinutes || 10) * 60 * 1000;
      const isPeriodicDue =
        !session.lastRunnerPingSentAt ||
        now - session.lastRunnerPingSentAt >= pingIntervalMs;

      let broadcastToHunters = false;
      let ping: HunterPing | undefined;

      if ((isSonarActive || isPeriodicDue) && session.phase === 'ACTIVE') {
        broadcastToHunters = true;
        session.lastRunnerPingSentAt = now;
        ping = {
          lat: data.lat,
          lng: data.lng,
          timestamp: now,
          triggerReason: isSonarActive ? 'SONAR_CURSE' : 'PERIODIC',
        };
      }

      // Check proximity with all active hunters
      let closestDistance: number | undefined;
      session.players.forEach((other) => {
        if (other.role === 'HUNTER' && other.lat !== 0 && other.lng !== 0) {
          const dist = computeDistanceMeters(data.lat, data.lng, other.lat, other.lng);
          if (closestDistance === undefined || dist < closestDistance) {
            closestDistance = dist;
          }
          if (dist <= session.settings.captureRadiusMeters) {
            session.captureCandidateHunterId = other.id;
          }
        }
      });

      return {
        success: true,
        session,
        broadcastToHunters,
        ping,
        distanceToRunner: closestDistance,
        captureOpportunity: session.captureCandidateHunterId !== null,
      };
    }

    // If Hunter moved
    if (player.role === 'HUNTER' && session.runnerId) {
      const runner = session.players.get(session.runnerId);
      if (runner && runner.lat !== 0 && runner.lng !== 0) {
        const distanceToRunner = computeDistanceMeters(data.lat, data.lng, runner.lat, runner.lng);
        const captureOpportunity = distanceToRunner <= session.settings.captureRadiusMeters;

        if (captureOpportunity) {
          session.captureCandidateHunterId = player.id;
        } else if (session.captureCandidateHunterId === player.id) {
          session.captureCandidateHunterId = null;
        }

        return {
          success: true,
          session,
          broadcastToHunters: false,
          distanceToRunner,
          captureOpportunity,
        };
      }
    }

    return {
      success: true,
      session,
      broadcastToHunters: false,
    };
  }

  /**
   * Attempt capture by a hunter within captureRadiusMeters
   */
  public attemptCapture(
    gameCode: string,
    hunterId: string
  ): {
    success: boolean;
    captured: boolean;
    distanceMeters?: number;
    hunterName?: string;
    session?: GameSession;
    error?: string;
  } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, captured: false, error: 'Session introuvable.' };

    if (session.phase !== 'ACTIVE') {
      return { success: false, captured: false, error: `Capture impossible en phase "${session.phase}".` };
    }

    const hunter = session.players.get(hunterId);
    if (!hunter || hunter.role !== 'HUNTER') {
      return { success: false, captured: false, error: 'Seul un chasseur peut tenter une capture.' };
    }

    if (!session.runnerId) {
      return { success: false, captured: false, error: 'Aucun Runner dans la session.' };
    }

    const runner = session.players.get(session.runnerId);
    if (!runner || runner.lat === 0 || runner.lng === 0) {
      return { success: false, captured: false, error: 'Coordonnées GPS du Runner indisponibles.' };
    }

    const distanceMeters = computeDistanceMeters(hunter.lat, hunter.lng, runner.lat, runner.lng);

    if (distanceMeters <= session.settings.captureRadiusMeters) {
      session.phase = 'CAPTURED';
      session.captureCandidateHunterId = hunterId;

      return {
        success: true,
        captured: true,
        distanceMeters,
        hunterName: hunter.name,
        session,
      };
    }

    return {
      success: false,
      captured: false,
      distanceMeters,
      error: `Trop éloigné du Runner (${distanceMeters}m > ${session.settings.captureRadiusMeters}m).`,
    };
  }

  /**
   * Runner accepts a Curse to earn coin bonus
   */
  public acceptCurse(
    gameCode: string,
    playerId: string,
    curse: ActiveCurse
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(playerId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut accepter une malédiction.' };
    }

    session.activeCurses.push({
      ...curse,
      appliedAt: Date.now(),
    });

    session.runnerCoins += curse.coinReward || 0;

    return { success: true, session };
  }

  /**
   * Exports GPX string from positions history
   */
  public exportGpx(
    gameCode: string
  ): { success: boolean; gpx?: string; filename?: string; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    // Export history (filter on runner if available, or full history)
    const gpx = generateGpx(session.gameCode, session.positionsHistory);
    const filename = `runaway_${session.gameCode}_${Date.now()}.gpx`;

    return { success: true, gpx, filename };
  }

  /**
   * Internal lifecycle checks (Jail Time expiration, Veto, Curses)
   */
  private checkPhaseAndPenalties(session: GameSession): void {
    const now = Date.now();

    // Check Jail Time expiration -> switch to ACTIVE
    if (session.phase === 'JAIL_TIME' && session.jailTimeEndsAt && now >= session.jailTimeEndsAt) {
      session.phase = 'ACTIVE';
      session.jailTimeEndsAt = null;
    }

    // Check Veto expiration
    if (session.activeVetoUntil && now >= session.activeVetoUntil) {
      session.activeVetoUntil = null;
    }

    // Check expired curses
    session.activeCurses = session.activeCurses.filter((curse) => {
      if (!curse.durationMs || !curse.appliedAt) return true;
      return now < curse.appliedAt + curse.durationMs;
    });
  }

  /**
   * List all session codes
   */
  public listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear all sessions (for unit testing)
   */
  public clearAll(): void {
    this.sessions.clear();
    this.socketToGame.clear();
  }
}
