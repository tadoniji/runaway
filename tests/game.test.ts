import assert from 'assert';
import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { GameManager } from '../src/GameManager';
import { setupSocketHandlers } from '../src/socket';
import {
  ClientToServerEvents,
  ServerToClientEvents,
} from '../src/types';

type TestClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function runTests() {
  console.log('--- TEST SUITE: Urban Manhunt Android-Aligned Socket.IO Protocol ---');

  const gameManager = GameManager.getInstance();
  gameManager.clearAll();

  // Create test server
  const app = express();
  const server = http.createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
    cors: { origin: '*' },
  });
  setupSocketHandlers(io);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const socketUrl = `http://127.0.0.1:${port}`;

  const hostClient: TestClientSocket = Client(socketUrl, { autoConnect: true });
  const hunterClient: TestClientSocket = Client(socketUrl, { autoConnect: true });

  await Promise.all([
    new Promise<void>((res) => hostClient.on('connect', () => res())),
    new Promise<void>((res) => hunterClient.on('connect', () => res())),
  ]);
  console.log(`  ✓ Both test sockets connected to test server on port ${port}`);

  // 1. CREATE_GAME
  console.log('\n[1] Testing create_game and lobby:updated...');
  const createGamePromise = new Promise<{ gameCode: string; initialCoins: number }>((resolve) => {
    hostClient.on('game_created', (data) => resolve(data));
  });

  hostClient.emit('create_game', {
    name: 'RunnerHost',
    wantsToBeRunner: true,
    initialCoins: 250,
    jailTimeMinutes: 0, // Direct active for testing
  });

  const createdData = await createGamePromise;
  assert.strictEqual(createdData.gameCode.length, 6, 'gameCode must be 6 characters');
  assert.strictEqual(createdData.initialCoins, 250);
  const gameCode = createdData.gameCode;
  console.log(`  ✓ Game created: room code "${gameCode}", coins: ${createdData.initialCoins}`);

  // 2. JOIN_GAME
  console.log('\n[2] Testing join_game...');
  const hunterLobbyPromise = new Promise<{ players: any[] }>((resolve) => {
    hunterClient.on('lobby:updated', (data) => {
      if (data.players.length === 2) resolve(data);
    });
  });

  hunterClient.emit('join_game', {
    gameId: gameCode,
    playerId: 'android_hunter_1',
    role: 'HUNTER',
    name: 'HunterPlayer',
    wantsToBeRunner: false,
  });

  const lobbyData = await hunterLobbyPromise;
  assert.strictEqual(lobbyData.players.length, 2);
  console.log(`  ✓ Hunter joined. Lobby has ${lobbyData.players.length} players`);

  // 3. TOGGLE READY & WANTS_RUNNER
  console.log('\n[3] Testing player:toggle_ready and player:toggle_wants_runner...');
  const readyPromise = new Promise<{ players: any[] }>((resolve) => {
    hostClient.on('lobby:updated', (data) => {
      const hunter = data.players.find((p) => p.name === 'HunterPlayer');
      if (hunter && hunter.isReady) resolve(data);
    });
  });

  hunterClient.emit('player:toggle_ready', { gameCode });
  const readyLobby = await readyPromise;
  const hunterP = readyLobby.players.find((p) => p.name === 'HunterPlayer');
  assert.strictEqual(hunterP?.isReady, true);
  console.log('  ✓ Hunter toggled ready state');

  // 4. START_GAME (Weighted selection -> host volunteered -> host is Runner)
  console.log('\n[4] Testing start_game...');
  const gameStartPromise = new Promise<{ runnerId: string; stage: string; jailTimeEndTime: number }>((resolve) => {
    hostClient.on('game:started', (data) => resolve(data));
  });

  const coinsUpdatePromise = new Promise<{ coins: number }>((resolve) => {
    hostClient.on('coins:updated', (data) => resolve(data));
  });

  hostClient.emit('start_game', { gameCode });

  const startedGame = await gameStartPromise;
  const initialCoinsPayload = await coinsUpdatePromise;
  assert.strictEqual(startedGame.runnerId, hostClient.id);
  assert.strictEqual(initialCoinsPayload.coins, 250);
  console.log(`  ✓ Game started! Runner: ${startedGame.runnerId}, stage: ${startedGame.stage}, coins: ${initialCoinsPayload.coins}`);

  // 5. TRANSIT TAXIMETER (Coins & Overdraft)
  console.log('\n[5] Testing transit_start and transit_stop...');
  hostClient.emit('transit_start', { mode: 'METRO' });
  await new Promise((r) => setTimeout(r, 50));

  // Simulate 3 minutes in transit
  const session = gameManager.getSession(gameCode);
  assert.ok(session?.activeTransit !== null);
  session!.activeTransit!.startTime = Date.now() - 3 * 60 * 1000;

  const transitStopCoinsPromise = new Promise<{ coins: number }>((resolve) => {
    hostClient.on('coins:updated', (data) => {
      if (data.coins === 160) resolve(data);
    });
  });

  hostClient.emit('transit_stop');
  const stoppedCoins = await transitStopCoinsPromise;
  assert.strictEqual(stoppedCoins.coins, 160);
  console.log(`  ✓ Transit stopped. Deducted 90 coins (3 min * 30). New balance: ${stoppedCoins.coins}`);

  // Overdraft test: 10 minutes in TRAIN_TER (350 coins) -> balance becomes -190
  console.log('\n[6] Testing transit overdraft penalties (suspect, veto, curse)...');
  hostClient.emit('transit_start', { mode: 'TRAIN_TER' });
  await new Promise((r) => setTimeout(r, 50));
  session!.activeTransit!.startTime = Date.now() - 10 * 60 * 1000;

  const suspectPromise = new Promise<{ isSuspect: boolean; reason?: string }>((resolve) => {
    hunterClient.on('game:suspect_alert', (data) => resolve(data));
  });
  const vetoPromise = new Promise<{ vetoEndTime: number }>((resolve) => {
    hunterClient.on('veto:started', (data) => resolve(data));
  });
  const cursePromise = new Promise<{ id: string; title: string; description: string; durationMinutes: number }>((resolve) => {
    hostClient.on('runner:curse_triggered', (data) => resolve(data));
  });

  hostClient.emit('transit_stop');

  const [suspectAlert, vetoAlert, curseAlert] = await Promise.all([
    suspectPromise,
    vetoPromise,
    cursePromise,
  ]);
  assert.strictEqual(suspectAlert.isSuspect, true);
  assert.ok(vetoAlert.vetoEndTime > Date.now());
  assert.ok(curseAlert.title.length > 0);
  console.log(`  ✓ Overdraft triggered! Suspect: ${suspectAlert.isSuspect}, Veto ends: ${new Date(vetoAlert.vetoEndTime).toLocaleTimeString()}, Curse: "${curseAlert.title}"`);

  // 7. PING GPS (Hunters updated & Runner ping)
  console.log('\n[7] Testing ping_gps & filtering...');
  // Hunter sends GPS -> other hunters updated
  const hunterGpsPromise = new Promise<Array<{ id: string; name: string; lat?: number; lng?: number }>>((resolve) => {
    hunterClient.on('hunters:updated', (list) => resolve(list));
  });

  hunterClient.emit('ping_gps', {
    lat: 43.6045,
    lng: 1.4442,
    timestamp: Date.now(),
    speedKmH: 4.5,
  });

  const huntersList = await hunterGpsPromise;
  assert.ok(huntersList.length >= 1);
  assert.strictEqual(huntersList[0].lat, 43.6045);
  console.log(`  ✓ Hunter GPS ping received and broadcasted to hunters list`);

  // Runner sends GPS (with sonar curse active, immediate broadcast)
  session!.activeCurseId = 'curse_sonar';
  const runnerPingPromise = new Promise<{ lat: number; lng: number; timestamp: number; speedKmH: number }>((resolve) => {
    hunterClient.on('runner:last_ping', (ping) => resolve(ping));
  });

  hostClient.emit('ping_gps', {
    lat: 43.60455,
    lng: 1.4442,
    timestamp: Date.now(),
    speedKmH: 12.0,
  });

  const runnerPing = await runnerPingPromise;
  assert.strictEqual(runnerPing.lat, 43.60455);
  console.log(`  ✓ Runner GPS ping broadcasted to Hunter (lat: ${runnerPing.lat}, speed: ${runnerPing.speedKmH} km/h)`);

  // 8. CAPTURE LOGIC (15 meters)
  console.log('\n[8] Testing hunter:attempt_capture and runner:confirm_captured...');
  // Distance between 43.6045 and 43.60455 is ~5.5 meters -> in range!
  const threatPromise = new Promise<{ inRange: boolean; hunterName: string; distance: number }>((resolve) => {
    hostClient.on('capture:threat', (data) => resolve(data));
  });

  hunterClient.emit('hunter:attempt_capture');
  const threatData = await threatPromise;
  assert.strictEqual(threatData.inRange, true);
  assert.ok(threatData.distance <= 15, 'Distance must be <= 15m');
  console.log(`  ✓ Capture threat received by Runner! In range: ${threatData.inRange}, distance: ${threatData.distance}m`);

  // Runner confirms captured
  const gameEndedPromise = new Promise<{ winner: string; history: any[] }>((resolve) => {
    hunterClient.on('game:ended', (data) => resolve(data));
  });

  hostClient.emit('runner:confirm_captured');
  const gameEnded = await gameEndedPromise;
  assert.strictEqual(gameEnded.winner, 'HUNTERS');
  assert.ok(gameEnded.history.length >= 2, 'History must contain recorded pings');
  console.log(`  ✓ Game ended confirmed! Winner: ${gameEnded.winner}, track history count: ${gameEnded.history.length}`);

  // 9. CURSE BONUS
  console.log('\n[9] Testing curse:accept bonus coins...');
  const curseCoinsPromise = new Promise<{ coins: number }>((resolve) => {
    hostClient.on('coins:updated', (data) => resolve(data));
  });

  const previousCoins = session!.runnerCoins;
  hostClient.emit('curse:accept', { curseId: 'curse_speed_limit', coinReward: 50 });
  const updatedCurseCoins = await curseCoinsPromise;
  assert.strictEqual(updatedCurseCoins.coins, previousCoins + 50);
  console.log(`  ✓ curse:accept credited +50 coins. New balance: ${updatedCurseCoins.coins}`);

  // Cleanup
  hostClient.disconnect();
  hunterClient.disconnect();
  io.close();
  server.close();

  console.log('\n================================================================');
  console.log('🎉 ALL ANDROID-ALIGNED SOCKET.IO TESTS PASSED SUCCESSFULLY! (9/9)');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
