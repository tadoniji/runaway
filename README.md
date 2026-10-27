# Runaway - Urban Manhunt Authoritative Backend 🏃💨🎯

Serveur backend autoritaire haute performance pour jeu de Manhunt urbain (format Jet Lag: The Game).
Développé en **Node.js**, **Express**, **Socket.IO** et **TypeScript**, optimisé pour un déploiement instantané sur **Render**.

---

## 🌟 Points Forts & Architecture

- **Authoritative Server (Anti-Triche)** : Le serveur est le seul détenteur de la vérité pour les timers de transports, le calcul des coins et la diffusion des coordonnées GPS. Les clients ne peuvent pas manipuler leur solde ni contourner un véto.
- **Gestion d'état en mémoire (`GameManager` singleton)** : Gestion multi-sessions instantanée via un identifiant `gameId`.
- **Rooms Socket.IO cloisonnées** :
  - `game:{gameId}` : Diffusion collective (états généraux, fin de trajet).
  - `game:{gameId}:hunters` : Canaux réservés aux chasseurs (pings GPS périodiques / alertes suspect).
  - `game:{gameId}:runners` : Canal confidentiel du runner.
- **Export GPX standardisé** : Disponible par événement WebSocket ou directement via endpoint REST HTTP téléchargeable (`/api/games/:gameId/gpx`).
- **CORS Permissif** : Prêt pour le développement et la production sur émulateurs Android (`10.0.2.2`), appareils physiques et builds Capacitor/Flutter/React Native.

---

## 🚇 Barème des Transports (`TransitMode`)

| Mode | Coût (coins / minute) | Description |
| :--- | :--- | :--- |
| `TRAIN_TER` | **35** | Train express régional |
| `METRO` | **30** | Métro urbain |
| `TELEO` | **25** | Téléphérique urbain |
| `BUS_LINEO` | **15** | Lignes de bus express à haut niveau de service |
| `TRAM` | **12** | Tramway |
| `BUS_LOCAL` | **6** | Lignes de bus standard / maillage local |

- **Solde de départ du Runner** : `250` coins.
- **Règle de découvert (`coins < 0`)** :
  1. Statut du Runner immédiatement basculé à `SUSPECT`.
  2. Veto actif de **20 minutes** (`activeVetoUntil = Date.now() + 20 * 60 * 1000`) interdisant tout nouveau transport.
  3. Tirage aléatoire immédiat d'une **Curse** (ex: *SONAR*, *FREEZE*, etc.).
  4. Émission d'une alerte prioritaire `suspect_alert` à tous les chasseurs.

---

## 📡 Contrat d'Événements Socket.IO

### 1. `join_game`
Rejoint la session de jeu et s'abonne aux canaux appropriés selon le rôle.
- **Payload client** :
  ```json
  {
    "gameId": "toulouse-01",
    "role": "RUNNER", // ou "HUNTER"
    "name": "Ben"
  }
  ```
- **Callback / Ack** : `{ "success": true, "state": GameState }`
- **Événements émis** : `player_joined`, `game_state_update`

---

### 2. `transit_start`
Démarre un chronomètre de transport (réservé au rôle `RUNNER`).
- **Payload client** :
  ```json
  {
    "gameId": "toulouse-01",
    "mode": "METRO"
  }
  ```
- **Vérifications autoritaires du serveur** :
  - Le joueur doit être le `RUNNER`.
  - `coins > 0`.
  - Aucun véto en cours (`activeVetoUntil < Date.now()`).
  - Aucun autre transit en cours.
- **Callback / Ack** : `{ "success": true, "state": GameState }`
- **Événements émis** : `transit_started`, `game_state_update`

---

### 3. `transit_stop`
Arrête le transport en cours, calcule la durée exacte et débite les coins.
- **Payload client** :
  ```json
  {
    "gameId": "toulouse-01"
  }
  ```
- **Calcul** : `(Date.now() - startTime) / 60000 * rate`
- **Callback / Ack** :
  ```json
  {
    "success": true,
    "report": {
      "mode": "METRO",
      "startTime": 1719500000000,
      "endTime": 1719500180000,
      "durationSeconds": 180,
      "durationMinutes": 3.0,
      "ratePerMinute": 30,
      "coinsDeducted": 90,
      "newCoinsBalance": 160,
      "penaltiesApplied": false
    },
    "state": GameState
  }
  ```
- **Si overdraft (`coins < 0`)** : Émet `suspect_alert` aux chasseurs.

---

### 4. `ping_gps`
Transmet la position du Runner.
- **Payload client** :
  ```json
  {
    "gameId": "toulouse-01",
    "lat": 43.6045,
    "lng": 1.4442,
    "altitude": 142.5,
    "speed": 1.2
  }
  ```
- **Logique de diffusion** :
  - La position est **toujours** archivée dans l'historique complet pour l'export GPX.
  - La position **n'est diffusée aux chasseurs (`hunter_ping`) que si** :
    1. Le délai périodique de **10 minutes** est écoulé depuis le dernier ping chasseur, **OU**
    2. La malédiction active est **`SONAR`** (transmission en direct forcée).
- **Callback / Ack** : `{ "success": true, "broadcasted": true | false }`

---

### 5. `export_gpx`
Renvoie le fichier GPX complet de la session sous forme de chaîne XML standard 1.1.
- **Payload client** : `{ "gameId": "toulouse-01" }`
- **Callback / Ack** : `{ "success": true, "gpx": "<?xml version..." }`
- **Événement émis** : `gpx_exported`

---

## 🌐 Endpoints REST HTTP

| Méthode | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Healthcheck pour Render Web Service (`200 OK`) |
| `GET` | `/api/games` | Liste synthétique des parties en mémoire |
| `GET` | `/api/games/:gameId` | État complet d'une session de jeu |
| `GET` | `/api/games/:gameId/gpx` | **Téléchargement direct du fichier `.gpx`** (header `attachment`) |

---

## 🚀 Déploiement sur Render (Web Service)

### Option 1 : Déploiement automatique via Blueprint (`render.yaml`)
1. Poussez ce dépôt sur GitHub ou GitLab.
2. Rendez-vous sur [dashboard.render.com](https://dashboard.render.com/).
3. Cliquez sur **New +** > **Blueprint**.
4. Sélectionnez votre dépôt : Render détecte automatiquement `render.yaml` et configure :
   - Runtime : `Node`
   - Build Command : `npm install && npm run build`
   - Start Command : `npm run start`
   - Health Check Path : `/health`
   - Variable `PORT` : assignée dynamiquement par Render.

### Option 2 : Déploiement manuel via Web Service
1. Cliquez sur **New +** > **Web Service**.
2. Connectez le dépôt Git.
3. Configurez :
   - **Environment** : `Node`
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `node dist/server.js` (ou `npm run start`)
   - **Health Check Path** : `/health`
4. Cliquez sur **Create Web Service**.

---

## 🛠️ Commandes Locales

```bash
# Installation des dépendances
npm install

# Démarrage en mode développement (avec rechargement à chaud)
npm run dev

# Exécution de la suite de tests (10 tests unitaires & intégration socket.io)
npm test

# Compilation TypeScript vers ./dist
npm run build

# Démarrage de la version compilée (Production)
npm run start
```
