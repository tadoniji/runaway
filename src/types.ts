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
// SOCKET.IO EVENT CONTRACTS (Android Client Aligned)
// ==========================================

export interface ClientToServerEvents {
  create_game: (payload: {
    name: string;
    wantsToBeRunner?: boolean;
    initialCoins?: number;
    jailTimeMinutes?: number;
  }) => void;

  join_game: (payload: {
    gameId: string;
    playerId: string;
    role: string;
    name: string;
    wantsToBeRunner?: boolean;
    avatarUri?: string;
  }) => void;

  'player:toggle_ready': (payload: { gameCode: string }) => void;

  'player:toggle_wants_runner': (payload: { gameCode: string }) => void;

  start_game: (payload: { gameCode: string }) => void;

  transit_start: (payload: { mode: string }) => void;

  transit_stop: () => void;

  ping_gps: (payload: {
    lat: number;
    lng: number;
    timestamp: number;
    speedKmH?: number;
  }) => void;

  'curse:accept': (payload: { curseId: string; coinReward: number }) => void;

  'curse:veto': (payload: { curseId: string; bonusCoins: number }) => void;

  'hunter:attempt_capture': () => void;

  'runner:confirm_captured': () => void;
}

export interface ServerToClientEvents {
  game_created: (payload: { gameCode: string; initialCoins: number }) => void;

  'lobby:updated': (payload: { players: any[] }) => void;

  'game:started': (payload: {
    runnerId: string;
    stage: string;
    jailTimeEndTime: number;
  }) => void;

  'coins:updated': (payload: { coins: number }) => void;

  'game:suspect_alert': (payload: { isSuspect: boolean; reason?: string }) => void;

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

  'hunters:updated': (
    payload: Array<{ id: string; name: string; lat?: number; lng?: number }>
  ) => void;

  'capture:threat': (payload: {
    inRange: boolean;
    hunterName: string;
    distance: number;
  }) => void;

  'game:ended': (payload: { winner: string; history: any[] }) => void;

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
