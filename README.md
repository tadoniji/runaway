# Runaway - Urban Manhunt Authoritative Backend 🏃💨🎯

Serveur backend autoritaire haute performance pour jeu de Manhunt urbain (format Jet Lag: The Game).
Développé en **Node.js**, **Express**, **Socket.IO** et **TypeScript**, synchronisé avec l'application cliente Android.

---

## 🌟 Architecture & Rôles

- **Serveur Autoritaire** : Le serveur est l'arbitre unique des timers de transport, calcul des soldes (coins), détection de faillite (overdraft / véto), pings GPS différés et vérification de la portée de capture (15m).
- **Code de Session à 6 Caractères** : Clé alphanumérique (ex: `QXKAWL`).
- **Tirage au Sort Pondéré du Runner** : Au lancement (`start_game`), les joueurs ayant activé `wantsToBeRunner` ont un poids prépondérant (poids 10 vs 1).
- **Taximètre des Transports** :
  - `TRAIN_TER`: 35 coins/min
  - `METRO`: 30 coins/min
  - `TELEO`: 25 coins/min
  - `BUS_LINEO`: 15 coins/min
  - `TRAM`: 12 coins/min
  - `BUS_LOCAL`: 6 coins/min
- **Gestion du Découvert (`coins < 0`)** :
  - Déclenchement de `game:suspect_alert` (`isSuspect: true`).
  - Déclenchement de `veto:started` (20 minutes d'interdiction de transport).
  - Déclenchement de `runner:curse_triggered` (malédiction tirée au sort).
- **Capture Géodésique (15m)** :
  - Sur `hunter:attempt_capture`, calcul Haversine immédiat. Si distance $\le 15\text{ m}$, diffusion de `capture:threat` (`inRange: true`).
  - Sur `runner:confirm_captured`, fige la session et diffuse `game:ended` avec l'historique complet.

---

## 📡 Contrat d'Événements Socket.IO (Client Android)

### 📤 Client ➔ Serveur (`ClientToServerEvents`)

| Événement | Payload | Description |
| :--- | :--- | :--- |
| `create_game` | `{ name: string, wantsToBeRunner?: boolean, initialCoins?: number, jailTimeMinutes?: number }` | Crée une session de jeu |
| `join_game` | `{ gameId: string, playerId: string, role: string, name: string, wantsToBeRunner?: boolean, avatarUri?: string }` | Rejoint une session |
| `player:toggle_ready` | `{ gameCode: string }` | Bascule le statut prêt du joueur |
| `player:toggle_wants_runner` | `{ gameCode: string }` | Bascule la volonté d'être runner |
| `start_game` | `{ gameCode: string }` | Lance la partie (tirage pondéré du runner) |
| `transit_start` | `{ mode: string }` | Démarre le chronomètre d'un transport |
| `transit_stop` | *(aucun)* | Arrête le transport et débite les coins |
| `ping_gps` | `{ lat: number, lng: number, timestamp: number, speedKmH?: number }` | Transmet la position d'un joueur |
| `curse:accept` | `{ curseId: string, coinReward: number }` | Accepte une malédiction pour gagner des coins |
| `curse:veto` | `{ curseId: string, bonusCoins: number }` | Veto de malédiction avec compensation |
| `hunter:attempt_capture` | *(aucun)* | Tente de capturer le runner |
| `runner:confirm_captured` | *(aucun)* | Confirme la capture et termine la partie |

### 📥 Serveur ➔ Client (`ServerToClientEvents`)

| Événement | Payload | Description |
| :--- | :--- | :--- |
| `game_created` | `{ gameCode: string, initialCoins: number }` | Confirmation de création de la session |
| `lobby:updated` | `{ players: any[] }` | Liste actualisée des joueurs dans le lobby |
| `game:started` | `{ runnerId: string, stage: string, jailTimeEndTime: number }` | Notification de lancement |
| `coins:updated` | `{ coins: number }` | Nouveau solde de coins du runner |
| `game:suspect_alert` | `{ isSuspect: boolean, reason?: string }` | Alerte de banqueroute émise à tous |
| `veto:started` | `{ vetoEndTime: number }` | Fin programmée du véto de transport (20 min) |
| `runner:curse_triggered` | `{ id: string, title: string, description: string, durationMinutes: number }` | Malédiction infligée |
| `runner:last_ping` | `{ lat: number, lng: number, timestamp: number, speedKmH: number, avatarUri?: string }` | Coordonnées du runner diffusées aux chasseurs |
| `hunters:updated` | `Array<{ id: string, name: string, lat?: number, lng?: number }>` | Positions partagées entre chasseurs |
| `capture:threat` | `{ inRange: boolean, hunterName: string, distance: number }` | Alerte de tentative de capture (portée 15m) |
| `game:ended` | `{ winner: string, history: any[] }` | Fin de partie avec trace GPS complète |

---

## 🌐 Endpoints REST HTTP

| Méthode | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Healthcheck Render (`200 OK`) |
| `GET` | `/api/games` | Liste synthétique des sessions actives |
| `GET` | `/api/games/:gameCode` | Détails complets d'une session |
| `GET` | `/api/games/:gameCode/gpx` | Téléchargement du fichier trace GPX 1.1 |

---

## 🛠️ Commandes Locales

```bash
# Installation des dépendances
npm install

# Exécution des tests automatisés (9/9)
npm test

# Compilation TypeScript vers dist/
npm run build

# Démarrage de production
npm run start
```
