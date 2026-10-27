export type PlayerRole = 'RUNNER' | 'HUNTER';

export type TransitMode =
  | 'TRAIN_TER'   // 35 coins / min
  | 'METRO'       // 30 coins / min
  | 'TELEO'       // 25 coins / min
  | 'BUS_LINEO'   // 15 coins / min
  | 'TRAM'        // 12 coins / min
  | 'BUS_LOCAL';  // 6 coins / min

export type GameStatus = 'NORMAL' | 'SUSPECT';

export interface Player {
  id: string; // Socket ID or unique device ID
  role: PlayerRole;
  name: string;
  joinedAt: number;
}

export interface ActiveTransit {
  mode: TransitMode;
  startTime: number;
}

export interface Curse {
  id: string;
  type: 'SONAR' | 'FREEZE' | 'NO_CHECK_IN' | 'SPEED_LIMIT';
  name: string;
  description: string;
  appliedAt: number;
  durationMs?: number;
}

export interface GpsPoint {
  lat: number;
  lng: number;
  timestamp: number;
  mode?: string;
  altitude?: number;
  speed?: number;
}

export interface HunterPing {
  lat: number;
  lng: number;
  timestamp: number;
  triggerReason: 'PERIODIC' | 'SONAR_CURSE' | 'MANUAL';
}

export interface GameState {
  gameId: string;
  coins: number;
  status: GameStatus;
  activeTransit: ActiveTransit | null;
  activeVetoUntil: number | null;
  activeCurse: Curse | null;
  history: GpsPoint[];
  lastHunterPing: HunterPing | null;
  players: Record<string, Player>;
  createdAt: number;
  updatedAt: number;
}

export interface TransitReport {
  mode: TransitMode;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  durationMinutes: number;
  ratePerMinute: number;
  coinsDeducted: number;
  newCoinsBalance: number;
  penaltiesApplied: boolean;
  curseApplied?: Curse;
  vetoUntil?: number;
}

// Socket.IO Payload Contracts
export interface JoinGamePayload {
  gameId: string;
  role: PlayerRole;
  name: string;
}

export interface TransitStartPayload {
  gameId: string;
  mode: TransitMode;
}

export interface TransitStopPayload {
  gameId: string;
}

export interface PingGpsPayload {
  gameId: string;
  lat: number;
  lng: number;
  altitude?: number;
  speed?: number;
}

export interface ExportGpxPayload {
  gameId: string;
}

// Socket.IO Event Interfaces
export interface ServerToClientEvents {
  game_state_update: (state: GameState) => void;
  player_joined: (player: Player) => void;
  player_left: (playerId: string) => void;
  transit_started: (transit: ActiveTransit) => void;
  transit_stopped: (report: TransitReport) => void;
  suspect_alert: (data: { reason: string; coins: number; vetoUntil: number; curse: Curse }) => void;
  hunter_ping: (ping: HunterPing) => void;
  gpx_exported: (data: { gpx: string; filename: string }) => void;
  error_message: (data: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  join_game: (
    payload: JoinGamePayload,
    callback?: (response: { success: boolean; state?: GameState; error?: string }) => void
  ) => void;
  transit_start: (
    payload: TransitStartPayload,
    callback?: (response: { success: boolean; state?: GameState; error?: string }) => void
  ) => void;
  transit_stop: (
    payload: TransitStopPayload,
    callback?: (response: { success: boolean; report?: TransitReport; state?: GameState; error?: string }) => void
  ) => void;
  ping_gps: (
    payload: PingGpsPayload,
    callback?: (response: { success: boolean; broadcasted: boolean; error?: string }) => void
  ) => void;
  export_gpx: (
    payload: ExportGpxPayload,
    callback?: (response: { success: boolean; gpx?: string; error?: string }) => void
  ) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  gameId?: string;
  playerId?: string;
  role?: PlayerRole;
  name?: string;
}
