export type PlayerRole = 'RUNNER' | 'HUNTER' | 'UNDECIDED';
export type GameStage = 'LOBBY' | 'JAIL_TIME' | 'ACTIVE' | 'CAPTURED' | 'ENDED';

export interface Player {
  id: string; // socket.id
  playerId?: string;
  name: string;
  role: PlayerRole;
  wantsToBeRunner: boolean;
  isReady: boolean;
  avatarUri?: string | null;
  lat: number;
  lng: number;
  speedKmH: number;
  lastSeen: number;
}

export interface PositionHistoryPoint {
  playerId: string;
  role: PlayerRole;
  name: string;
  lat: number;
  lng: number;
  timestamp: number;
  speedKmH?: number;
  speed?: number;
  mode?: string;
  altitude?: number;
}

export type PositionPoint = PositionHistoryPoint;

export interface ActiveTransit {
  mode: string;
  startTime: number;
}

export interface GameSettings {
  pingIntervalMinutes: number; // e.g. 10
  jailTimeMinutes: number; // e.g. 15
  vetoDurationMinutes: number; // e.g. 20
  captureRadiusMeters: number; // e.g. 15
  transportRates: Record<string, number>;
}

export interface GameSession {
  gameCode: string; // 6-character room code
  hostId: string;
  stage: GameStage;
  settings: GameSettings;
  players: Map<string, Player>;
  runnerId: string | null;
  runnerCoins: number;
  activeTransit: ActiveTransit | null;
  activeVetoUntil: number | null;
  jailTimeEndTime: number;
  lastRunnerPingSentAt: number | null;
  activeCurseId: string | null;
  isSuspect: boolean;
  isEnded: boolean;
  winner: string | null;
  history: PositionHistoryPoint[];
  createdAt: number;
}

// ==========================================
// SOCKET.IO EVENT CONTRACTS (Android Client & Legacy Aligned)
// ==========================================

export interface ClientToServerEvents {
  create_game: (
    payload: {
      gameId?: string;
      gameCode?: string;
      name: string;
      wantsToBeRunner?: boolean;
      initialCoins?: number;
      jailTimeMinutes?: number;
    },
    callback?: (response: any) => void
  ) => void;

  join_game: (
    payload: {
      gameId?: string;
      gameCode?: string;
      playerId?: string;
      role?: string;
      name: string;
      wantsToBeRunner?: boolean;
      avatarUri?: string;
    },
    callback?: (response: any) => void
  ) => void;

  'player:toggle_ready': (payload: {
    gameCode?: string;
    gameId?: string;
    name?: string;
    isReady?: boolean;
    role?: string;
  }) => void;

  'player:toggle_wants_runner': (payload: {
    gameCode?: string;
    gameId?: string;
    name?: string;
    wantsToBeRunner?: boolean;
  }) => void;

  start_game: (payload: {
    gameCode?: string;
    gameId?: string;
    runnerId?: string;
    runnerName?: string;
  }) => void;

  'game:start': (payload: {
    gameCode?: string;
    gameId?: string;
    runnerId?: string;
    runnerName?: string;
  }) => void;

  transit_start: (
    payload: { mode: string; gameId?: string },
    callback?: (response: any) => void
  ) => void;

  transit_stop: (
    payload?: { gameId?: string },
    callback?: (response: any) => void
  ) => void;

  ping_gps: (
    payload: {
      gameId?: string;
      lat: number;
      lng: number;
      timestamp?: number;
      speed?: number;
      speedKmH?: number;
      altitude?: number;
    },
    callback?: (response: any) => void
  ) => void;

  'curse:accept': (payload: { curseId: string; coinReward: number }) => void;

  'curse:veto': (payload: { curseId: string; bonusCoins: number }) => void;

  'hunter:attempt_capture': () => void;

  'runner:confirm_captured': () => void;

  export_gpx: (
    payload: { gameId?: string; gameCode?: string },
    callback?: (response: any) => void
  ) => void;
}

export interface ServerToClientEvents {
  game_created: (payload: { gameCode: string; initialCoins: number }) => void;

  'lobby:updated': (payload: { players: any[] }) => void;

  'game:started': (payload: {
    runnerId: string;
    stage: string;
    jailTimeEndTime: number;
  }) => void;

  game_started: (payload: {
    runnerId: string;
    stage: string;
    jailTimeEndTime: number;
  }) => void;

  game_state_update: (payload: any) => void;

  player_joined: (payload: any) => void;

  player_left: (payload: any) => void;

  'coins:updated': (payload: { coins: number }) => void;

  'game:suspect_alert': (payload: {
    isSuspect: boolean;
    reason?: string;
    coins?: number;
    vetoUntil?: number;
    curse?: any;
  }) => void;

  suspect_alert: (payload: {
    isSuspect?: boolean;
    reason?: string;
    coins?: number;
    vetoUntil?: number;
    curse?: any;
  }) => void;

  'veto:started': (payload: { vetoEndTime: number }) => void;

  'runner:curse_triggered': (payload: {
    id: string;
    title: string;
    description: string;
    durationMinutes: number;
  }) => void;

  'runner:last_ping': (payload: {
    lat: number;
    lng: number;
    timestamp: number;
    speedKmH: number;
    avatarUri?: string;
  }) => void;

  hunter_ping: (payload: {
    lat: number;
    lng: number;
    timestamp: number;
    speedKmH: number;
    avatarUri?: string;
  }) => void;

  'hunters:updated': (
    payload: Array<{ id: string; name: string; lat?: number; lng?: number }>
  ) => void;

  'capture:threat': (payload: {
    inRange: boolean;
    hunterName: string;
    distance: number;
  }) => void;

  'game:ended': (payload: { winner: string; history: any[] }) => void;

  transit_started: (payload: any) => void;

  transit_stopped: (payload: any) => void;

  gpx_exported: (payload: { gpx: string; filename: string }) => void;

  error_message?: (payload: { code: string; message: string }) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  gameCode?: string;
  playerId?: string;
  role?: PlayerRole;
  name?: string;
}
