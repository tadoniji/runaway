import assert from 'assert';
import http from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { GameManager } from '../src/GameManager';
import { setupSocketHandlers } from '../src/socket';
import {
  ClientToServerEvents,
  GameSessionDTO,
  HunterPing,
  ServerToClientEvents,
  TransitReport,
} from '../src/types';

type TestClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function runTests() {
  console.log('--- TEST SUITE: Urban Manhunt Updated Architecture ---');

  const gameManager = GameManager.getInstance();
  gameManager.clearAll();

  // ==========================================
  // UNIT TESTS: GameManager Logic
  // ==========================================
  console.log('\n[1] Testing GameManager Unit Logic...');

  // 1.1 Create Session in LOBBY phase
  const session = gameManager.createGame('socket_host_1', 'Ben Host', null, true, {
    jailTimeMinutes: 10,
    captureRadiusMeters: 15,
  });

  assert.strictEqual(session.gameCode.length, 6, 'Game code should be 6 characters');
  assert.strictEqual(session.phase, 'LOBBY', 'Initial phase must be LOBBY');
  assert.strictEqual(session.runnerCoins, 250, 'Initial runner coins must be 250');
  assert.strictEqual(session.hostId, 'socket_host_1');
  assert.strictEqual(session.players.size, 1);
  console.log(`  ✓ Game session created with code "${session.gameCode}" in phase LOBBY`);

  // 1.2 Add Hunter Player
  const hunterJoin = gameManager.addPlayer(session.gameCode, {
    id: 'socket_hunter_1',
    name: 'Sam Hunter',
    wantsRunner: false,
    role: 'HUNTER',
  });
  assert.strictEqual(session.players.size, 2);
  assert.strictEqual(hunterJoin.player.role, 'HUNTER');
  console.log('  ✓ Hunter player joined lobby');

  // 1.3 Lobby actions: set ready & wantsRunner
  gameManager.setPlayerReady(session.gameCode, 'socket_hunter_1', true);
  assert.strictEqual(session.players.get('socket_hunter_1')?.isReady, true);
  console.log('  ✓ Player readiness toggled');

  // 1.4 Start Game -> transitions to JAIL_TIME
  const startResult = gameManager.startGame(session.gameCode, 'socket_host_1');
  assert.strictEqual(startResult.success, true);
  assert.strictEqual(session.phase, 'JAIL_TIME', 'Phase must transition to JAIL_TIME');
  assert.ok(session.jailTimeEndsAt !== null, 'Jail time timer must be set');
  assert.strictEqual(session.runnerId, 'socket_host_1', 'Host was runner candidate');
  console.log(`  ✓ Game started! Phase is JAIL_TIME until ${new Date(session.jailTimeEndsAt!).toLocaleTimeString()}`);

  // 1.5 Runner transit during Jail Time
  const transitStart = gameManager.startTransit(session.gameCode, 'socket_host_1', 'METRO');
  assert.strictEqual(transitStart.success, true);
  assert.strictEqual(session.activeTransit?.mode, 'METRO');
  console.log('  ✓ Transit METRO started by Runner');

  // Simulate 3 minutes transit
  if (session.activeTransit) {
    session.activeTransit.startTimestamp = Date.now() - 3 * 60 * 1000;
  }
  const transitStop = gameManager.stopTransit(session.gameCode, 'socket_host_1');
  assert.strictEqual(transitStop.success, true);
  // Cost: 3 * 30 = 90. Balance: 250 - 90 = 160.
  assert.strictEqual(session.runnerCoins, 160);
  console.log(`  ✓ Transit stopped. Deducted: ${transitStop.report?.coinsDeducted} coins. Balance: ${session.runnerCoins}`);

  // 1.6 Fast forward Jail Time to test ACTIVE phase
  session.jailTimeEndsAt = Date.now() - 1000;
  gameManager.getSession(session.gameCode); // Triggers lifecycle check
  assert.strictEqual(session.phase, 'ACTIVE', 'Phase should transition to ACTIVE after jail time');
  console.log('  ✓ Phase transitioned to ACTIVE after Jail Time expiration');

  // 1.7 GPS Recording & Proximity Check
  // Runner position: Toulouse Capitole (43.6045, 1.4442)
  const runnerGps = gameManager.recordPosition(session.gameCode, 'socket_host_1', {
    lat: 43.6045,
    lng: 1.4442,
  });
  assert.strictEqual(runnerGps.success, true);
  assert.strictEqual(runnerGps.broadcastToHunters, true, 'First ping broadcasts');

  // Hunter distant: 500 meters away -> no capture opportunity
  const hunterFar = gameManager.recordPosition(session.gameCode, 'socket_hunter_1', {
    lat: 43.6090,
    lng: 1.4442,
  });
  assert.strictEqual(hunterFar.captureOpportunity, false);
  const farCapture = gameManager.attemptCapture(session.gameCode, 'socket_hunter_1');
  assert.strictEqual(farCapture.captured, false, 'Capture must fail when distance > 15m');
  console.log('  ✓ Capture rejected at 500m distance');

  // Hunter approaches to 10 meters away -> capture opportunity
  const hunterClose = gameManager.recordPosition(session.gameCode, 'socket_hunter_1', {
    lat: 43.60455,
    lng: 1.4442, // ~5.5 meters apart
  });
  assert.strictEqual(hunterClose.captureOpportunity, true, 'Capture opportunity within 15m');
  console.log(`  ✓ Proximity detected: Hunter within capture radius (${hunterClose.distanceToRunner}m)`);

  // Attempt Capture
  const captureSuccess = gameManager.attemptCapture(session.gameCode, 'socket_hunter_1');
  assert.strictEqual(captureSuccess.success, true);
  assert.strictEqual(captureSuccess.captured, true);
  assert.strictEqual(session.phase, 'CAPTURED');
  console.log('  ✓ Runner captured! Phase transitioned to CAPTURED');

  // 1.8 GPX Export check
  const gpxExport = gameManager.exportGpx(session.gameCode);
  assert.strictEqual(gpxExport.success, true);
  assert.ok(gpxExport.gpx?.includes('<gpx version="1.1"'));
  assert.ok(gpxExport.gpx?.includes('lat="43.6045000"'));
  console.log('  ✓ GPX export properly created from position history');

  // ==========================================
  // INTEGRATION TESTS: Socket.IO Server & Client
  // ==========================================
  console.log('\n[2] Testing Socket.IO Integration with New Architecture...');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
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

  // Host creates game
  const createdGamePromise = new Promise<{ gameCode: string; session: GameSessionDTO }>((resolve) => {
    hostClient.emit(
      'create_game',
      { hostName: 'HostPlayer', wantsRunner: true, settings: { jailTimeMinutes: 0 } },
      (resp) => {
        assert.strictEqual(resp.success, true);
        resolve({ gameCode: resp.gameCode!, session: resp.session! });
      }
    );
  });
  const { gameCode } = await createdGamePromise;
  console.log(`  ✓ Socket host created game: ${gameCode}`);

  // Hunter joins game
  const hunterJoinPromise = new Promise<GameSessionDTO>((resolve) => {
    hunterClient.emit(
      'join_game',
      { gameCode, name: 'HunterPlayer', wantsRunner: false, role: 'HUNTER' },
      (resp) => {
        assert.strictEqual(resp.success, true);
        resolve(resp.session!);
      }
    );
  });
  const joinedSession = await hunterJoinPromise;
  assert.strictEqual(Object.keys(joinedSession.players).length, 2);
  console.log('  ✓ Hunter joined via Socket.IO');

  // Start game via Socket (jailTime = 0 -> directly ACTIVE)
  const startGamePromise = new Promise<GameSessionDTO>((resolve) => {
    hostClient.emit('start_game', { gameCode }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve(resp.session!);
    });
  });
  const activeSession = await startGamePromise;
  assert.strictEqual(activeSession.phase, 'ACTIVE');
  console.log('  ✓ Game started via Socket.IO directly in ACTIVE phase');

  // Runner GPS Ping
  const pingPromise = new Promise<HunterPing>((resolve) => {
    hunterClient.on('hunter_ping', (ping) => resolve(ping));
  });

  await new Promise<void>((resolve) => {
    hostClient.emit('ping_gps', { gameCode, lat: 43.6045, lng: 1.4442 }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve();
    });
  });

  const receivedPing = await pingPromise;
  assert.strictEqual(receivedPing.lat, 43.6045);
  console.log('  ✓ GPS ping broadcasted to Hunter');

  // Hunter moves close to runner
  await new Promise<void>((resolve) => {
    hunterClient.emit('ping_gps', { gameCode, lat: 43.60451, lng: 1.4442 }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve();
    });
  });

  // Hunter captures Runner via Socket
  const capturePromise = new Promise<{ captured: boolean }>((resolve) => {
    hunterClient.emit('attempt_capture', { gameCode }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve({ captured: resp.captured! });
    });
  });
  const captureResult = await capturePromise;
  assert.strictEqual(captureResult.captured, true);
  console.log('  ✓ attempt_capture successful via Socket.IO');

  // Export GPX via Socket
  const gpxPromise = new Promise<string>((resolve) => {
    hostClient.emit('export_gpx', { gameCode }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve(resp.gpx!);
    });
  });
  const exportedGpx = await gpxPromise;
  assert.ok(exportedGpx.includes('<gpx version="1.1"'));
  console.log('  ✓ export_gpx returned valid GPX content via Socket.IO');

  // Cleanup
  hostClient.disconnect();
  hunterClient.disconnect();
  io.close();
  server.close();

  console.log('\n======================================================');
  console.log('🎉 ALL ARCHITECTURE TESTS PASSED SUCCESSFULLY! (10/10)');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
