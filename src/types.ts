export type GamePhase = 'LOBBY' | 'JAIL_TIME' | 'ACTIVE' | 'CAPTURED' | 'ENDED';
export type PlayerRole = 'RUNNER' | 'HUNTER' | 'UNDECIDED';

export interface GameSettings {
  pingIntervalMinutes: number;        // Intervalle de transmission GPS aux chasseurs (ex. 10)
  jailTimeMinutes: number;            // Période d'avance du runner avant la traque
  vetoDurationMinutes: number;        // Durée de blocage lors d'un véto
  captureRadiusMeters: number;        // Distance max pour tenter une capture (défaut : 15m)
  transportRates: Record<string, number>; // Coût à la minute par mode (ex. { METRO: 30, TER: 35 })
  challenges: any[];                  // Liste des défis configurés par l'hôte
}

export interface Player {
  id: string;                         // socket.id
  name: string;
  role: PlayerRole;
  wantsRunner: boolean;               // Volontaire pour être runner
  isReady: boolean;
  avatarUrl: string | null;           // Image personnalisée pour la carte
  lat: number;
  lng: number;
  lastSeen: number;
}

export interface ActiveCurse {
  id: string;
  title: string;
  description: string;
  coinReward: number;                 // Bonus crédité à l'acceptation
  type?: 'SONAR' | 'FREEZE' | 'SPEED_LIMIT' | 'NO_CHECK_IN' | string;
  appliedAt?: number;
  durationMs?: number;
}

export interface PositionPoint {
  playerId: string;
  role: PlayerRole;
  lat: number;
  lng: number;
  timestamp: number;
  mode?: string;
  altitude?: number;
  speed?: number;
}

export interface GameSession {
  gameCode: string;                   // Clé unique à 6 caractères
  hostId: string;                     // socket.id du créateur
  phase: GamePhase;
  settings: GameSettings;
  players: Map<string, Player>;
  runnerId: string | null;
  runnerCoins: number;
  activeTransit: { mode: string; startTimestamp: number } | null;
  activeVetoUntil: number | null;
  activeCurses: ActiveCurse[];
  jailTimeEndsAt: number | null;
  lastRunnerPingSentAt: number | null;
  captureCandidateHunterId: string | null;
  positionsHistory: PositionPoint[];  // Trace complète pour la carte de débriefing
}

/**
 * Serialized GameSession suitable for JSON transmission over WebSockets / HTTP
 * Replaces Map<string, Player> with a standard Record<string, Player>
 */
export interface GameSessionDTO extends Omit<GameSession, 'players'> {
  players: Record<string, Player>;
}

export interface TransitReport {
  mode: string;
  startTimestamp: number;
  endTimestamp: number;
  durationSeconds: number;
  durationMinutes: number;
  ratePerMinute: number;
  coinsDeducted: number;
  newCoinsBalance: number;
  penaltiesApplied: boolean;
  curseApplied?: ActiveCurse;
  vetoUntil?: number;
}

export interface HunterPing {
  lat: number;
  lng: number;
  timestamp: number;
  triggerReason: 'PERIODIC' | 'SONAR_CURSE' | 'JAIL_TIME_END' | 'MANUAL';
}

// Client-to-Server Payload Contracts
export interface CreateGamePayload {
  hostName: string;
  avatarUrl?: string | null;
  wantsRunner?: boolean;
  settings?: Partial<GameSettings>;
}

export interface JoinGamePayload {
  gameCode?: string;
  gameId?: string; // Backwards compatibility
  name: string;
  avatarUrl?: string | null;
  wantsRunner?: boolean;
  role?: PlayerRole;
}

export interface UpdateSettingsPayload {
  gameCode: string;
  settings: Partial<GameSettings>;
}

export interface SetReadyPayload {
  gameCode: string;
  isReady: boolean;
}

export interface SetWantsRunnerPayload {
  gameCode: string;
  wantsRunner: boolean;
}

export interface AssignRolePayload {
  gameCode: string;
  targetPlayerId: string;
  role: PlayerRole;
}

export interface StartTransitPayload {
  gameCode?: string;
  gameId?: string; // Backwards compatibility
  mode: string;
}

export interface StopTransitPayload {
  gameCode?: string;
  gameId?: string; // Backwards compatibility
}

export interface PingGpsPayload {
  gameCode?: string;
  gameId?: string; // Backwards compatibility
  lat: number;
  lng: number;
  altitude?: number;
  speed?: number;
}

export interface AttemptCapturePayload {
  gameCode: string;
}

export interface AcceptCursePayload {
  gameCode: string;
  curse: ActiveCurse;
}

export interface ExportGpxPayload {
  gameCode?: string;
  gameId?: string; // Backwards compatibility
}

// Socket.IO Event Interfaces
export interface ServerToClientEvents {
  game_state_update: (session: GameSessionDTO) => void;
  player_joined: (player: Player) => void;
  player_left: (playerId: string) => void;
  transit_started: (transit: { mode: string; startTimestamp: number }) => void;
  transit_stopped: (report: TransitReport) => void;
  suspect_alert: (data: { reason: string; coins: number; vetoUntil: number; curse?: ActiveCurse }) => void;
  hunter_ping: (ping: HunterPing) => void;
  hunter_location_update: (data: { hunterId: string; name: string; lat: number; lng: number }) => void;
  capture_opportunity: (data: { hunterId: string; distanceMeters: number }) => void;
  runner_captured: (data: { hunterId: string; hunterName: string; timestamp: number }) => void;
  phase_changed: (data: { phase: GamePhase; jailTimeEndsAt: number | null }) => void;
  gpx_exported: (data: { gpx: string; filename: string }) => void;
  error_message: (data: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  create_game: (
    payload: CreateGamePayload,
    callback?: (response: { success: boolean; gameCode?: string; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  join_game: (
    payload: JoinGamePayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  update_settings: (
    payload: UpdateSettingsPayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  set_ready: (
    payload: SetReadyPayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  set_wants_runner: (
    payload: SetWantsRunnerPayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  assign_role: (
    payload: AssignRolePayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  start_game: (
    payload: { gameCode: string },
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  transit_start: (
    payload: StartTransitPayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  transit_stop: (
    payload: StopTransitPayload,
    callback?: (response: { success: boolean; report?: TransitReport; session?: GameSessionDTO; error?: string }) => void
  ) => void;
  ping_gps: (
    payload: PingGpsPayload,
    callback?: (response: { success: boolean; broadcasted: boolean; distanceToRunner?: number; error?: string }) => void
  ) => void;
  attempt_capture: (
    payload: AttemptCapturePayload,
    callback?: (response: { success: boolean; captured?: boolean; distanceMeters?: number; error?: string }) => void
  ) => void;
  accept_curse: (
    payload: AcceptCursePayload,
    callback?: (response: { success: boolean; session?: GameSessionDTO; error?: string }) => void
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
  gameCode?: string;
  playerId?: string;
  role?: PlayerRole;
  name?: string;
}
