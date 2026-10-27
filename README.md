# Runaway - Urban Manhunt Authoritative Backend 🏃💨🎯

Serveur backend autoritaire haute performance pour jeu de Manhunt urbain (format Jet Lag: The Game).
Développé en **Node.js**, **Express**, **Socket.IO** et **TypeScript**, déployé sur **Render**.

---

## 🌟 Architecture & Nouveautés

- **Authoritative Server (Anti-Triche)** : Le serveur arbitre de façon absolue les timers de transport, le calcul des coins, la gestion du Jail Time, les véto et la distance de capture.
- **Machine à États Multi-Phases (`GamePhase`)** :
  - `LOBBY` : Salle d'attente, sélection du runner (`wantsRunner`), readiness des joueurs (`isReady`), configuration des règles (`GameSettings`) par l'hôte.
  - `JAIL_TIME` : Période d'avance du Runner (`jailTimeMinutes`) avant le départ des chasseurs.
  - `ACTIVE` : Traque active avec pings GPS périodiques, transits urbains et détection de proximité.
  - `CAPTURED` : Capture réussie d'un Runner par un Hunter à moins de `captureRadiusMeters` (ex: 15 mètres).
  - `ENDED` : Fin de session et débriefing.
- **Session par Code Unique (`gameCode`)** : Clé alphanumérique unique à 6 caractères (ex: `Z8K2M9`).
- **Gestion d'état en mémoire (`GameManager` singleton)** : Stockage autoritaire avec `Map<string, Player>` et conversion sérialisée JSON automatique pour Socket.IO (`GameSessionDTO`).
- **Formule de Haversine Intégrée** : Détection ultra-précise de proximité géodésique entre Runner et Hunters pour déclencher l'opportunité de capture (`capture_opportunity`).
- **Export GPX standardisé** : Traces complètes (`positionsHistory`) exportables par WebSocket ou téléchargement direct HTTP (`/api/games/:gameCode/gpx`).

---

## ⚙️ Modèle de Données (`types.ts`)

```typescript
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
}

export interface PositionPoint {
  playerId: string;
  role: PlayerRole;
  lat: number;
  lng: number;
  timestamp: number;
  mode?: string;
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
```

---

## 🚇 Barème des Transports par Défaut (`transportRates`)

| Mode | Coût (coins / min) | Description |
| :--- | :--- | :--- |
| `TRAIN_TER` | **35** | Train express régional |
| `METRO` | **30** | Métro urbain |
| `TELEO` | **25** | Téléphérique urbain |
| `BUS_LINEO` | **15** | Lignes de bus express |
| `TRAM` | **12** | Tramway |
| `BUS_LOCAL` | **6** | Lignes de bus locales |

---

## 📡 Événements Socket.IO Principaux

### 1. `create_game`
- **Client** : `{ hostName: string, avatarUrl?: string, wantsRunner?: boolean, settings?: Partial<GameSettings> }`
- **Ack** : `{ success: true, gameCode: "AB12CD", session: GameSessionDTO }`

### 2. `join_game`
- **Client** : `{ gameCode: "AB12CD", name: string, avatarUrl?: string, wantsRunner?: boolean, role?: PlayerRole }`
- **Ack** : `{ success: true, session: GameSessionDTO }`

### 3. `start_game` (Hôte uniquement)
- **Client** : `{ gameCode: "AB12CD" }`
- **Effet** : Désigne le Runner, bascule en `JAIL_TIME` (ou `ACTIVE`) et notifie `phase_changed`.

### 4. `transit_start` / `transit_stop`
- **Client** : `{ gameCode: "AB12CD", mode: "METRO" }`
- **Effet** : Débit automatique des coins à l'arrêt selon la durée réelle. En cas de découvert (`runnerCoins < 0`), déclenche véto + malédiction et alerte `suspect_alert` aux chasseurs.

### 5. `ping_gps`
- **Client** : `{ gameCode: "AB12CD", lat: 43.6045, lng: 1.4442 }`
- **Effet** :
  - Archive la coordonnée dans `positionsHistory`.
  - Diffuse `hunter_ping` aux chasseurs si intervalle de 10 min écoulé ou curse `SONAR`.
  - Calcule la distance de capture en direct et émet `capture_opportunity` aux chasseurs éligibles.

### 6. `attempt_capture`
- **Client** : `{ gameCode: "AB12CD" }`
- **Effet** : Vérifie si la distance avec le runner est `<= captureRadiusMeters` (ex: 15m). Si oui, transitionne en phase `CAPTURED` et diffuse `runner_captured`.

### 7. `export_gpx`
- **Client** : `{ gameCode: "AB12CD" }`
- **Ack** : `{ success: true, gpx: "<?xml..." }`

---

## 🌐 Endpoints REST HTTP

| Méthode | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Healthcheck Render (`200 OK`) |
| `GET` | `/api/games` | Liste synthétique des sessions actives |
| `GET` | `/api/games/:gameCode` | État complet sérialisé d'une partie |
| `GET` | `/api/games/:gameCode/gpx` | Téléchargement du fichier trace GPX 1.1 |

---

## 🛠️ Commandes Locales

```bash
# Installation des dépendances
npm install

# Exécution des tests unitaires et intégration (10/10)
npm test

# Compilation TypeScript vers dist/
npm run build

# Démarrage de production
npm run start
```
