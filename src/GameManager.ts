import {
  CAPTURE_RADIUS_METERS,
  CURSE_TEMPLATES,
  CurseTemplate,
  DEFAULT_INITIAL_COINS,
  DEFAULT_JAIL_TIME_MINUTES,
  DEFAULT_PING_INTERVAL_MINUTES,
  DEFAULT_VETO_DURATION_MINUTES,
  TRANSIT_RATES,
} from './constants';
import {
  ActiveTransit,
  GameSession,
  Player,
  PlayerRole,
  PositionHistoryPoint,
} from './types';
import { computeDistanceMeters } from './utils/geo';
import { generateGpx } from './utils/gpxGenerator';

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
   * Generates a 6-character room code (uppercase alphanumeric, non-ambiguous)
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
   * Creates a new game session
   */
  public createGame(
    hostSocketId: string,
    payload: {
      name: string;
      wantsToBeRunner?: boolean;
      initialCoins?: number;
      jailTimeMinutes?: number;
    }
  ): { session: GameSession; player: Player } {
    const gameCode = this.generateGameCode();
    const now = Date.now();
    const initialCoins = payload.initialCoins ?? DEFAULT_INITIAL_COINS;
    const jailTimeMinutes = payload.jailTimeMinutes ?? DEFAULT_JAIL_TIME_MINUTES;

    const hostPlayer: Player = {
      id: hostSocketId,
      name: payload.name.trim() || 'Host',
      role: payload.wantsToBeRunner ? 'RUNNER' : 'UNDECIDED',
      wantsToBeRunner: payload.wantsToBeRunner ?? false,
      isReady: true,
      avatarUri: null,
      lat: 0,
      lng: 0,
      speedKmH: 0,
      lastSeen: now,
    };

    const playersMap = new Map<string, Player>();
    playersMap.set(hostSocketId, hostPlayer);

    const session: GameSession = {
      gameCode,
      hostId: hostSocketId,
      stage: 'LOBBY',
      settings: {
        pingIntervalMinutes: DEFAULT_PING_INTERVAL_MINUTES,
        jailTimeMinutes,
        vetoDurationMinutes: DEFAULT_VETO_DURATION_MINUTES,
        captureRadiusMeters: CAPTURE_RADIUS_METERS,
        transportRates: { ...TRANSIT_RATES },
      },
      players: playersMap,
      runnerId: payload.wantsToBeRunner ? hostSocketId : null,
      runnerCoins: initialCoins,
      activeTransit: null,
      activeVetoUntil: null,
      jailTimeEndTime: 0,
      lastRunnerPingSentAt: null,
      activeCurseId: null,
      isSuspect: false,
      isEnded: false,
      winner: null,
      history: [],
      createdAt: now,
    };

    this.sessions.set(gameCode, session);
    this.socketToGame.set(hostSocketId, gameCode);

    return { session, player: hostPlayer };
  }

  /**
   * Returns an existing session or initializes a session for a given code
   */
  public getOrCreateSession(gameCode: string, hostSocketId?: string): GameSession {
    const normalized = gameCode.trim().toUpperCase();
    let session = this.sessions.get(normalized);
    if (session) return session;

    session = {
      gameCode: normalized,
      hostId: hostSocketId || 'host_default',
      stage: 'LOBBY',
      settings: {
        pingIntervalMinutes: DEFAULT_PING_INTERVAL_MINUTES,
        jailTimeMinutes: DEFAULT_JAIL_TIME_MINUTES,
        vetoDurationMinutes: DEFAULT_VETO_DURATION_MINUTES,
        captureRadiusMeters: CAPTURE_RADIUS_METERS,
        transportRates: { ...TRANSIT_RATES },
      },
      players: new Map<string, Player>(),
      runnerId: null,
      runnerCoins: DEFAULT_INITIAL_COINS,
      activeTransit: null,
      activeVetoUntil: null,
      jailTimeEndTime: 0,
      lastRunnerPingSentAt: null,
      activeCurseId: null,
      isSuspect: false,
      isEnded: false,
      winner: null,
      history: [],
      createdAt: Date.now(),
    };

    this.sessions.set(normalized, session);
    return session;
  }

  /**
   * Retrieves a session by game code
   */
  public getSession(gameCode: string): GameSession | undefined {
    return this.sessions.get(gameCode.trim().toUpperCase());
  }

  /**
   * Retrieves a session by socket ID
   */
  public getSessionBySocketId(socketId: string): GameSession | undefined {
    const code = this.socketToGame.get(socketId);
    return code ? this.getSession(code) : undefined;
  }

  /**
   * Joins an existing game
   */
  public joinGame(
    socketId: string,
    payload: {
      gameId: string;
      playerId?: string;
      role?: string;
      name: string;
      wantsToBeRunner?: boolean;
      avatarUri?: string;
    }
  ): { session: GameSession; player: Player } {
    const gameCode = payload.gameId.trim().toUpperCase();
    const session = this.getOrCreateSession(gameCode, socketId);
    const now = Date.now();

    const roleUpper = payload.role?.toUpperCase();
    const role: PlayerRole =
      roleUpper === 'RUNNER'
        ? 'RUNNER'
        : roleUpper === 'HUNTER'
        ? 'HUNTER'
        : payload.wantsToBeRunner
        ? 'RUNNER'
        : 'UNDECIDED';

    const player: Player = {
      id: socketId,
      playerId: payload.playerId || socketId,
      name: payload.name.trim() || `Player_${socketId.slice(0, 4)}`,
      role,
      wantsToBeRunner: payload.wantsToBeRunner ?? (role === 'RUNNER'),
      isReady: false,
      avatarUri: payload.avatarUri || null,
      lat: 0,
      lng: 0,
      speedKmH: 0,
      lastSeen: now,
    };

    session.players.set(socketId, player);
    this.socketToGame.set(socketId, session.gameCode);

    if (role === 'RUNNER' && !session.runnerId) {
      session.runnerId = socketId;
    }

    return { session, player };
  }

  /**
   * Toggles ready state for a player
   */
  public toggleReady(gameCode: string, socketId: string): { success: boolean; session?: GameSession } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false };

    const player = session.players.get(socketId);
    if (!player) return { success: false };

    player.isReady = !player.isReady;
    return { success: true, session };
  }

  /**
   * Toggles wants runner volunteer state
   */
  public toggleWantsRunner(gameCode: string, socketId: string): { success: boolean; session?: GameSession } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false };

    const player = session.players.get(socketId);
    if (!player) return { success: false };

    player.wantsToBeRunner = !player.wantsToBeRunner;
    return { success: true, session };
  }

  /**
   * Starts game with weighted selection of runner
   */
  public startGame(gameCode: string): {
    success: boolean;
    session?: GameSession;
    runner?: Player;
    jailTimeEndTime?: number;
    error?: string;
  } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const playersList = Array.from(session.players.values());
    if (playersList.length === 0) return { success: false, error: 'Aucun joueur.' };

    // Weighted selection of runner:
    // Volunteers have a weight of 10, non-volunteers have a weight of 1.
    // If no one volunteered, all players have equal probability.
    const hasVolunteers = playersList.some((p) => p.wantsToBeRunner);
    const weightedPool: Player[] = [];

    playersList.forEach((p) => {
      const weight = hasVolunteers ? (p.wantsToBeRunner ? 10 : 1) : 1;
      for (let i = 0; i < weight; i++) {
        weightedPool.push(p);
      }
    });

    const chosenRunner = weightedPool[Math.floor(Math.random() * weightedPool.length)];
    session.runnerId = chosenRunner.id;

    // Assign roles
    playersList.forEach((p) => {
      if (p.id === chosenRunner.id) {
        p.role = 'RUNNER';
      } else {
        p.role = 'HUNTER';
      }
    });

    const now = Date.now();
    const jailMinutes = session.settings.jailTimeMinutes ?? DEFAULT_JAIL_TIME_MINUTES;
    const jailTimeEndTime = now + jailMinutes * 60 * 1000;

    session.jailTimeEndTime = jailTimeEndTime;
    session.stage = jailMinutes > 0 ? 'JAIL_TIME' : 'ACTIVE';
    session.activeTransit = null;
    session.activeVetoUntil = null;
    session.activeCurseId = null;
    session.isSuspect = false;
    session.isEnded = false;
    session.winner = null;

    return {
      success: true,
      session,
      runner: chosenRunner,
      jailTimeEndTime,
    };
  }

  /**
   * Starts a transit mode for runner
   */
  public startTransit(
    socketId: string,
    mode: string
  ): { success: boolean; session?: GameSession; error?: string } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(socketId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut démarrer un transit.' };
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

    session.activeTransit = {
      mode,
      startTime: now,
    };

    return { success: true, session };
  }

  /**
   * Stops active transit, calculates cost, checks overdraft
   */
  public stopTransit(socketId: string): {
    success: boolean;
    session?: GameSession;
    coinsDeducted?: number;
    newCoinsBalance?: number;
    isOverdraft?: boolean;
    curse?: CurseTemplate;
    vetoEndTime?: number;
    error?: string;
  } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(socketId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut arrêter son transit.' };
    }

    if (!session.activeTransit) {
      return { success: false, error: 'Aucun transit actif.' };
    }

    const now = Date.now();
    const { mode, startTime } = session.activeTransit;
    const elapsedSeconds = Math.max(0, Math.round((now - startTime) / 1000));
    const durationMinutes = elapsedSeconds / 60;

    const rate = session.settings.transportRates[mode] ?? 15;
    const coinsDeducted = Math.ceil(durationMinutes * rate);

    session.runnerCoins -= coinsDeducted;
    session.activeTransit = null;

    let isOverdraft = false;
    let curse: CurseTemplate | undefined;
    let vetoEndTime: number | undefined;

    if (session.runnerCoins < 0) {
      isOverdraft = true;
      session.isSuspect = true;
      vetoEndTime = now + (session.settings.vetoDurationMinutes || 20) * 60 * 1000;
      session.activeVetoUntil = vetoEndTime;

      curse = CURSE_TEMPLATES[Math.floor(Math.random() * CURSE_TEMPLATES.length)];
      session.activeCurseId = curse.id;
    }

    return {
      success: true,
      session,
      coinsDeducted,
      newCoinsBalance: session.runnerCoins,
      isOverdraft,
      curse,
      vetoEndTime,
    };
  }

  /**
   * Records GPS coordinate and evaluates broadcast / hunter locations
   */
  public recordGpsPing(
    socketId: string,
    data: { lat: number; lng: number; timestamp: number; speedKmH?: number }
  ): {
    success: boolean;
    session?: GameSession;
    isRunner: boolean;
    broadcastRunnerPing: boolean;
    runnerPingPayload?: {
      lat: number;
      lng: number;
      timestamp: number;
      speedKmH: number;
      avatarUri?: string;
    };
    huntersList?: Array<{ id: string; name: string; lat: number; lng: number }>;
    error?: string;
  } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false, isRunner: false, broadcastRunnerPing: false, error: 'Session introuvable.' };

    const player = session.players.get(socketId);
    if (!player) return { success: false, isRunner: false, broadcastRunnerPing: false, error: 'Joueur introuvable.' };

    const now = data.timestamp || Date.now();
    player.lat = data.lat;
    player.lng = data.lng;
    player.speedKmH = data.speedKmH || 0;
    player.lastSeen = now;

    // Full debrief history
    const historyPoint: PositionHistoryPoint = {
      playerId: player.id,
      role: player.role,
      name: player.name,
      lat: data.lat,
      lng: data.lng,
      timestamp: now,
      speedKmH: player.speedKmH,
      mode: session.activeTransit?.mode,
    };
    session.history.push(historyPoint);

    // If Hunter: return updated hunter positions
    if (player.role === 'HUNTER') {
      const huntersList: Array<{ id: string; name: string; lat: number; lng: number }> = [];
      session.players.forEach((p) => {
        if (p.role === 'HUNTER' && p.lat !== 0 && p.lng !== 0) {
          huntersList.push({
            id: p.id,
            name: p.name,
            lat: p.lat,
            lng: p.lng,
          });
        }
      });

      return {
        success: true,
        session,
        isRunner: false,
        broadcastRunnerPing: false,
        huntersList,
      };
    }

    // If Runner: check broadcast conditions to hunters
    const isSonarActive = session.activeCurseId === 'curse_sonar';
    const isJailTimeOver = session.jailTimeEndTime === 0 || now >= session.jailTimeEndTime;
    const intervalMs = (session.settings.pingIntervalMinutes || 10) * 60 * 1000;
    const isPeriodicDue =
      !session.lastRunnerPingSentAt || now - session.lastRunnerPingSentAt >= intervalMs;

    let broadcastRunnerPing = false;
    let runnerPingPayload;

    if (isSonarActive || (isJailTimeOver && isPeriodicDue)) {
      broadcastRunnerPing = true;
      session.lastRunnerPingSentAt = now;
      runnerPingPayload = {
        lat: data.lat,
        lng: data.lng,
        timestamp: now,
        speedKmH: player.speedKmH,
        avatarUri: player.avatarUri || undefined,
      };
    }

    return {
      success: true,
      session,
      isRunner: true,
      broadcastRunnerPing,
      runnerPingPayload,
    };
  }

  /**
   * Hunter attempts capture
   */
  public attemptCapture(hunterSocketId: string): {
    success: boolean;
    session?: GameSession;
    inRange: boolean;
    hunterName: string;
    distance: number;
    runnerSocketId?: string;
    error?: string;
  } {
    const session = this.getSessionBySocketId(hunterSocketId);
    if (!session) return { success: false, inRange: false, hunterName: '', distance: 999999, error: 'Session introuvable.' };

    const hunter = session.players.get(hunterSocketId);
    if (!hunter || hunter.role !== 'HUNTER') {
      return { success: false, inRange: false, hunterName: '', distance: 999999, error: 'Seul un chasseur peut tenter la capture.' };
    }

    if (!session.runnerId) {
      return { success: false, inRange: false, hunterName: hunter.name, distance: 999999, error: 'Aucun Runner dans la session.' };
    }

    const runner = session.players.get(session.runnerId);
    if (!runner || runner.lat === 0 || runner.lng === 0) {
      return { success: false, inRange: false, hunterName: hunter.name, distance: 999999, error: 'Coordonnées GPS du Runner indisponibles.' };
    }

    const distance = computeDistanceMeters(hunter.lat, hunter.lng, runner.lat, runner.lng);
    const inRange = distance <= (session.settings.captureRadiusMeters || CAPTURE_RADIUS_METERS);

    return {
      success: true,
      session,
      inRange,
      hunterName: hunter.name,
      distance,
      runnerSocketId: runner.id,
    };
  }

  /**
   * Runner confirms capture -> freezes session and ends game
   */
  public confirmCaptured(runnerSocketId: string): {
    success: boolean;
    session?: GameSession;
    history?: PositionHistoryPoint[];
    winner?: string;
    error?: string;
  } {
    const session = this.getSessionBySocketId(runnerSocketId);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const runner = session.players.get(runnerSocketId);
    if (!runner || runner.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut confirmer sa capture.' };
    }

    session.isEnded = true;
    session.stage = 'ENDED';
    session.winner = 'HUNTERS';

    return {
      success: true,
      session,
      history: session.history,
      winner: 'HUNTERS',
    };
  }

  /**
   * Accepts curse bonus
   */
  public acceptCurse(
    socketId: string,
    coinReward: number
  ): { success: boolean; session?: GameSession; newCoins?: number } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false };

    session.runnerCoins += coinReward;
    return { success: true, session, newCoins: session.runnerCoins };
  }

  /**
   * Veto curse bonus
   */
  public vetoCurse(
    socketId: string,
    bonusCoins: number
  ): { success: boolean; session?: GameSession; vetoEndTime?: number; newCoins?: number } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false };

    session.runnerCoins += bonusCoins;
    const vetoEndTime = Date.now() + (session.settings.vetoDurationMinutes || 20) * 60 * 1000;
    session.activeVetoUntil = vetoEndTime;

    return {
      success: true,
      session,
      vetoEndTime,
      newCoins: session.runnerCoins,
    };
  }

  /**
   * Formats players list for lobby:updated
   */
  public getLobbyPlayers(session: GameSession): any[] {
    return Array.from(session.players.values()).map((p) => ({
      id: p.id,
      playerId: p.playerId || p.id,
      name: p.name,
      role: p.role,
      isReady: p.isReady,
      wantsToBeRunner: p.wantsToBeRunner,
      avatarUri: p.avatarUri || null,
    }));
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
    }

    return { session, removedPlayer };
  }

  /**
   * GPX export from position history
   */
  public exportGpx(gameCode: string): { success: boolean; gpx?: string; filename?: string; error?: string } {
    const session = this.getSession(gameCode);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const gpxPoints = session.history.map((h) => ({
      playerId: h.playerId,
      role: h.role,
      lat: h.lat,
      lng: h.lng,
      timestamp: h.timestamp,
      speed: h.speedKmH,
      mode: h.mode,
    }));

    const gpx = generateGpx(session.gameCode, gpxPoints as any);
    const filename = `runaway_${session.gameCode}_${Date.now()}.gpx`;

    return { success: true, gpx, filename };
  }

  /**
   * List all session codes
   */
  public listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear all sessions (for unit tests)
   */
  public clearAll(): void {
    this.sessions.clear();
    this.socketToGame.clear();
  }
}
