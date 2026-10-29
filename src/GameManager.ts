import fs from 'fs';
import path from 'path';
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

const SESSIONS_FILE = path.resolve(process.cwd(), 'data_sessions.json');

export class GameManager {
  private static instance: GameManager;
  private sessions: Map<string, GameSession> = new Map();
  // Reverse lookup: socketId -> gameCode
  private socketToGame: Map<string, string> = new Map();

  private constructor() {
    this.loadFromDisk();
  }

  public static getInstance(): GameManager {
    if (!GameManager.instance) {
      GameManager.instance = new GameManager();
    }
    return GameManager.instance;
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, any> = {};
      this.sessions.forEach((session, code) => {
        if (session.stage !== 'ENDED') {
          const playersObj: Record<string, any> = {};
          session.players.forEach((p, id) => {
            playersObj[id] = p;
          });
          data[code] = {
            ...session,
            players: playersObj,
          };
        }
      });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[GameManager] Failed to persist sessions to disk:', e);
    }
  }

  public loadFromDisk(): void {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      let count = 0;
      Object.keys(data).forEach((code) => {
        const rawSession = data[code];
        const playersMap = new Map<string, Player>();
        if (rawSession.players) {
          Object.keys(rawSession.players).forEach((pId) => {
            const player = rawSession.players[pId];
            playersMap.set(pId, player);
            this.socketToGame.set(pId, code);
          });
        }
        const session: GameSession = {
          ...rawSession,
          players: playersMap,
        };
        this.sessions.set(code, session);
        count++;
      });
      if (count > 0) {
        console.log(`[GameManager] Restored ${count} active session(s) from disk persistence.`);
      }
    } catch (e) {
      console.error('[GameManager] Failed to load sessions from disk:', e);
    }
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
      gameId?: string;
      gameCode?: string;
      name: string;
      wantsToBeRunner?: boolean;
      initialCoins?: number;
      jailTimeMinutes?: number;
    }
  ): { session: GameSession; player: Player } {
    const requestedCode = (payload.gameId || payload.gameCode || '').trim().toUpperCase();
    const gameCode = requestedCode.length === 6 ? requestedCode : this.generateGameCode();
    const now = Date.now();
    const initialCoins = payload.initialCoins ?? DEFAULT_INITIAL_COINS;
    const jailTimeMinutes = payload.jailTimeMinutes ?? DEFAULT_JAIL_TIME_MINUTES;

    const hostPlayer: Player = {
      id: hostSocketId,
      playerId: hostSocketId,
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
    this.saveToDisk();

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
   * Joins an existing game with reconnection / re-association support
   */
  public joinGame(
    socketId: string,
    payload: {
      gameId?: string;
      gameCode?: string;
      playerId?: string;
      role?: string;
      name: string;
      wantsToBeRunner?: boolean;
      avatarUri?: string;
    }
  ): { session: GameSession; player: Player } {
    const rawCode = payload.gameId || payload.gameCode || 'DEFAULT';
    const gameCode = rawCode.trim().toUpperCase();
    const session = this.getOrCreateSession(gameCode, socketId);
    const now = Date.now();

    const normalizedName = payload.name.trim();

    // Check if player already exists in this session by name or playerId (Reconnection handling)
    const existingEntry = Array.from(session.players.entries()).find(([oldSockId, p]) => {
      const matchPlayerId = payload.playerId && p.playerId === payload.playerId;
      const matchName = normalizedName && p.name.toLowerCase() === normalizedName.toLowerCase();
      return matchPlayerId || matchName;
    });

    if (existingEntry) {
      const [oldSockId, existingPlayer] = existingEntry;

      // Clean up previous socket mapping if socket changed
      if (oldSockId !== socketId) {
        session.players.delete(oldSockId);
        this.socketToGame.delete(oldSockId);
      }

      existingPlayer.id = socketId;
      existingPlayer.lastSeen = now;
      if (payload.avatarUri) existingPlayer.avatarUri = payload.avatarUri;
      if (payload.wantsToBeRunner !== undefined) existingPlayer.wantsToBeRunner = payload.wantsToBeRunner;

      session.players.set(socketId, existingPlayer);
      this.socketToGame.set(socketId, session.gameCode);

      if (session.runnerId === oldSockId) {
        session.runnerId = socketId;
      }
      if (session.hostId === oldSockId) {
        session.hostId = socketId;
      }

      console.log(`[Reconnection] Player "${existingPlayer.name}" reconnected with new socket ${socketId}`);
      this.saveToDisk();
      return { session, player: existingPlayer };
    }

    // Brand new player joining
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
      name: normalizedName || `Player_${socketId.slice(0, 4)}`,
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

    this.saveToDisk();
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
    this.saveToDisk();
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
    this.saveToDisk();
    return { success: true, session };
  }

  /**
   * Starts game with runner selection
   */
  public startGame(gameCode: string, designatedRunnerNameOrId?: string): {
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

    let chosenRunner: Player | undefined;

    // Check if a specific runner was requested by the host
    if (designatedRunnerNameOrId) {
      chosenRunner = playersList.find(
        (p) => p.id === designatedRunnerNameOrId || p.playerId === designatedRunnerNameOrId || p.name.toLowerCase() === designatedRunnerNameOrId.toLowerCase()
      );
    }

    if (!chosenRunner) {
      // Weighted selection: Volunteers have 10x chance
      const hasVolunteers = playersList.some((p) => p.wantsToBeRunner);
      const weightedPool: Player[] = [];

      playersList.forEach((p) => {
        const weight = hasVolunteers ? (p.wantsToBeRunner ? 10 : 1) : 1;
        for (let i = 0; i < weight; i++) {
          weightedPool.push(p);
        }
      });

      chosenRunner = weightedPool[Math.floor(Math.random() * weightedPool.length)];
    }

    session.runnerId = chosenRunner.id;

    // Assign roles
    playersList.forEach((p) => {
      if (p.id === chosenRunner!.id) {
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

    this.saveToDisk();

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
    this.saveToDisk();

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
    mode?: string;
    durationMinutes?: number;
    report?: {
      mode: string;
      durationMinutes: number;
      coinsDeducted: number;
      newCoinsBalance: number;
      penaltiesApplied: boolean;
      curseApplied?: CurseTemplate;
      vetoUntil?: number;
    };
    error?: string;
  } {
    const session = this.getSessionBySocketId(socketId);
    if (!session) return { success: false, error: 'Session introuvable.' };

    const player = session.players.get(socketId);
    if (!player || player.role !== 'RUNNER') {
      return { success: false, error: 'Seul le Runner peut arrêter un transit.' };
    }

    if (!session.activeTransit) {
      return { success: false, error: 'Aucun transit en cours.' };
    }

    const { mode, startTime } = session.activeTransit;
    const now = Date.now();
    const elapsedMinutes = Math.max(1, Math.ceil((now - startTime) / (60 * 1000)));

    const rate = session.settings.transportRates[mode] ?? TRANSIT_RATES[mode] ?? 25;
    const coinsDeducted = elapsedMinutes * rate;

    session.runnerCoins -= coinsDeducted;
    session.activeTransit = null;

    let isOverdraft = false;
    let curse: CurseTemplate | undefined;
    let vetoEndTime: number | undefined;

    if (session.runnerCoins < 0) {
      isOverdraft = true;
      session.isSuspect = true;
      curse = CURSE_TEMPLATES[Math.floor(Math.random() * CURSE_TEMPLATES.length)];
      session.activeCurseId = curse.id;

      const vetoMinutes = session.settings.vetoDurationMinutes ?? DEFAULT_VETO_DURATION_MINUTES;
      vetoEndTime = now + vetoMinutes * 60 * 1000;
      session.activeVetoUntil = vetoEndTime;
    }

    const report = {
      mode,
      durationMinutes: elapsedMinutes,
      coinsDeducted,
      newCoinsBalance: session.runnerCoins,
      penaltiesApplied: isOverdraft,
      curseApplied: curse,
      vetoUntil: vetoEndTime,
    };

    this.saveToDisk();

    return {
      success: true,
      session,
      coinsDeducted,
      newCoinsBalance: session.runnerCoins,
      isOverdraft,
      curse,
      vetoEndTime,
      mode,
      durationMinutes: elapsedMinutes,
      report,
    };
  }

  /**
   * Records GPS coordinate and evaluates broadcast / hunter locations
   */
  public recordGpsPing(
    socketId: string,
    data: { lat: number; lng: number; timestamp?: number; speedKmH?: number; speed?: number }
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
    player.speedKmH = data.speedKmH || data.speed || 0;
    player.lastSeen = now;

    // History tracking
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
   * Hunter attempts capture: computes distance to runner
   */
  public attemptCapture(hunterSocketId: string): {
    success: boolean;
    session?: GameSession;
    inRange: boolean;
    distance: number;
    hunterName: string;
    error?: string;
  } {
    const session = this.getSessionBySocketId(hunterSocketId);
    if (!session) return { success: false, inRange: false, distance: 9999, hunterName: '', error: 'Session introuvable.' };

    const hunter = session.players.get(hunterSocketId);
    if (!hunter || hunter.role !== 'HUNTER') {
      return { success: false, inRange: false, distance: 9999, hunterName: '', error: 'Seul un Chasseur peut lancer une capture.' };
    }

    if (!session.runnerId) {
      return { success: false, inRange: false, distance: 9999, hunterName: hunter.name, error: 'Aucun Runner dans la session.' };
    }

    const runner = session.players.get(session.runnerId);
    if (!runner) {
      return { success: false, inRange: false, distance: 9999, hunterName: hunter.name, error: 'Runner introuvable.' };
    }

    const distMeters = computeDistanceMeters(hunter.lat, hunter.lng, runner.lat, runner.lng);
    const radiusMeters = session.settings.captureRadiusMeters || CAPTURE_RADIUS_METERS;
    const inRange = distMeters <= radiusMeters;

    return {
      success: true,
      session,
      inRange,
      distance: Math.round(distMeters * 10) / 10,
      hunterName: hunter.name,
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
    this.saveToDisk();

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
    this.saveToDisk();
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

    session.runnerCoins -= bonusCoins;
    const vetoEndTime = Date.now() + (session.settings.vetoDurationMinutes || 20) * 60 * 1000;
    session.activeVetoUntil = vetoEndTime;
    this.saveToDisk();

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
      isHost: p.id === session.hostId || p.playerId === session.hostId,
    }));
  }

  /**
   * Serializes session to legacy game_state_update format
   */
  public getGameStateLegacy(session: GameSession): any {
    const playersObj: Record<string, any> = {};
    session.players.forEach((p, socketId) => {
      playersObj[socketId] = {
        id: socketId,
        playerId: p.playerId || socketId,
        role: p.role,
        name: p.name,
        isReady: p.isReady,
        wantsToBeRunner: p.wantsToBeRunner,
        avatarUri: p.avatarUri || null,
        isHost: socketId === session.hostId || p.playerId === session.hostId,
        joinedAt: p.lastSeen,
      };
    });

    return {
      gameId: session.gameCode,
      coins: session.runnerCoins,
      status: session.isSuspect ? 'SUSPECT' : 'NORMAL',
      activeTransit: session.activeTransit,
      activeVetoUntil: session.activeVetoUntil,
      activeCurse: session.activeCurseId,
      history: session.history,
      lastHunterPing: session.history.filter((h) => h.role === 'RUNNER').pop() || null,
      players: playersObj,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
    };
  }

  /**
   * Handles player disconnection gracefully (persists player so reconnect doesn't drop room)
   */
  public removePlayer(socketId: string): { session?: GameSession; removedPlayer?: Player } {
    const gameCode = this.socketToGame.get(socketId);
    if (!gameCode) return {};

    const session = this.sessions.get(gameCode);
    if (!session) return {};

    const player = session.players.get(socketId);
    if (player) {
      player.lastSeen = Date.now();
      // Keep player in session so mobile reconnection re-attaches seamlessly!
    }
    return { session, removedPlayer: player };
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
