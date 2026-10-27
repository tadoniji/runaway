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
  TransitReport,
  GameState,
  HunterPing,
} from '../src/types';

type TestClientSocket = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

async function runTests() {
  console.log('--- TEST SUITE: Urban Manhunt Authoritative Backend ---');

  const gameManager = GameManager.getInstance();
  gameManager.clearAll();

  // ==========================================
  // UNIT TESTS: GameManager Logic
  // ==========================================
  console.log('\n[1] Testing GameManager Unit Logic...');
  const testGameId = 'game_alpha';

  // 1.1 Initial State
  const initialGame = gameManager.getOrCreateGame(testGameId);
  assert.strictEqual(initialGame.coins, 250, 'Initial balance should be 250 coins');
  assert.strictEqual(initialGame.status, 'NORMAL', 'Initial status should be NORMAL');
  assert.strictEqual(initialGame.activeTransit, null, 'No initial active transit');
  assert.strictEqual(initialGame.activeVetoUntil, null, 'No initial active veto');
  assert.strictEqual(initialGame.activeCurse, null, 'No initial active curse');
  console.log('  ✓ Initial state confirmed: 250 coins, NORMAL status');

  // 1.2 Add Players
  const runner = gameManager.addPlayer(testGameId, {
    id: 'socket_runner_1',
    role: 'RUNNER',
    name: 'Ben',
  });
  const hunter = gameManager.addPlayer(testGameId, {
    id: 'socket_hunter_1',
    role: 'HUNTER',
    name: 'Sam',
  });
  assert.strictEqual(runner.player.role, 'RUNNER');
  assert.strictEqual(hunter.player.role, 'HUNTER');
  console.log('  ✓ Players registered correctly');

  // 1.3 Hunter cannot start transit (Authoritative check)
  const hunterTransit = gameManager.startTransit(testGameId, 'socket_hunter_1', 'METRO');
  assert.strictEqual(hunterTransit.success, false, 'Hunter must not be able to start transit');
  console.log('  ✓ Authoritative security: Hunter transit start rejected');

  // 1.4 Runner starts transit METRO (30 coins/min)
  const startTransitRes = gameManager.startTransit(testGameId, 'socket_runner_1', 'METRO');
  assert.strictEqual(startTransitRes.success, true, 'Runner should start transit');
  assert.strictEqual(startTransitRes.game?.activeTransit?.mode, 'METRO');
  console.log('  ✓ Runner transit started (mode: METRO)');

  // 1.5 Runner cannot start a second transit while one is active
  const secondTransitRes = gameManager.startTransit(testGameId, 'socket_runner_1', 'BUS_LINEO');
  assert.strictEqual(secondTransitRes.success, false, 'Cannot start overlapping transit');
  console.log('  ✓ Overlapping transit rejected');

  // 1.6 Stop transit: simulate 3 minutes elapsed
  if (startTransitRes.game?.activeTransit) {
    // Artificial time travel: 3 minutes back
    startTransitRes.game.activeTransit.startTime = Date.now() - 3 * 60 * 1000;
  }
  const stopTransitRes = gameManager.stopTransit(testGameId, 'socket_runner_1');
  assert.strictEqual(stopTransitRes.success, true);
  // Cost: 3 minutes * 30 coins/min = 90 coins. New balance: 250 - 90 = 160 coins.
  assert.strictEqual(stopTransitRes.report?.coinsDeducted, 90, 'Cost should be 90 coins');
  assert.strictEqual(stopTransitRes.game?.coins, 160, 'Balance should be 160 coins');
  assert.strictEqual(stopTransitRes.game?.status, 'NORMAL');
  console.log(`  ✓ Transit stopped. Deducted: ${stopTransitRes.report?.coinsDeducted} coins. Balance: ${stopTransitRes.game?.coins}`);

  // 1.7 Overdraft & Curse Test
  // Start another transit and simulate 10 minutes in TRAIN_TER (35 coins/min = 350 coins)
  const startTrain = gameManager.startTransit(testGameId, 'socket_runner_1', 'TRAIN_TER');
  assert.strictEqual(startTrain.success, true);
  if (startTrain.game?.activeTransit) {
    startTrain.game.activeTransit.startTime = Date.now() - 10 * 60 * 1000;
  }
  const stopTrain = gameManager.stopTransit(testGameId, 'socket_runner_1');
  // 160 - 350 = -190 coins -> Overdraft!
  assert.ok(stopTrain.game!.coins < 0, 'Coins should be negative');
  assert.strictEqual(stopTrain.game?.status, 'SUSPECT', 'Status must transition to SUSPECT');
  assert.ok(stopTrain.game?.activeCurse !== null, 'Curse must be applied');
  assert.ok(stopTrain.game?.activeVetoUntil !== null, 'Veto must be set for 20 minutes');
  console.log(`  ✓ Overdraft triggered! Coins: ${stopTrain.game?.coins}, Status: ${stopTrain.game?.status}, Curse: ${stopTrain.game?.activeCurse?.name}`);

  // 1.8 Verify transit rejection while veto is active
  const rejectedDuringVeto = gameManager.startTransit(testGameId, 'socket_runner_1', 'BUS_LOCAL');
  assert.strictEqual(rejectedDuringVeto.success, false, 'Transit should be blocked during veto');
  console.log('  ✓ Transit correctly blocked during active veto');

  // 1.9 GPS Ping recording & Hunter broadcast logic
  const ping1 = gameManager.recordGpsPing(testGameId, 'socket_runner_1', {
    lat: 43.6045,
    lng: 1.4442,
  });
  // Since activeCurse might be SONAR or lastHunterPing was null, ping1 will broadcast
  assert.strictEqual(ping1.success, true);
  assert.strictEqual(ping1.broadcastToHunters, true, 'First ping should broadcast to hunters');
  assert.strictEqual(initialGame.history.length, 1);

  // Immediate second ping without SONAR (temporarily remove curse to test periodic logic)
  const savedCurse = stopTrain.game!.activeCurse;
  stopTrain.game!.activeCurse = null;
  const ping2 = gameManager.recordGpsPing(testGameId, 'socket_runner_1', {
    lat: 43.6050,
    lng: 1.4450,
  });
  assert.strictEqual(ping2.broadcastToHunters, false, 'Immediate second ping should NOT broadcast to hunters');
  assert.strictEqual(initialGame.history.length, 2, 'History still records the point');
  console.log('  ✓ GPS history recorded without leaking immediate location to hunters');

  // Restore SONAR curse: ping should now force broadcast
  stopTrain.game!.activeCurse = {
    id: 'curse_sonar_test',
    type: 'SONAR',
    name: 'Sonar Test',
    description: 'Test sonar',
    appliedAt: Date.now(),
  };
  const pingSonar = gameManager.recordGpsPing(testGameId, 'socket_runner_1', {
    lat: 43.6060,
    lng: 1.4460,
  });
  assert.strictEqual(pingSonar.broadcastToHunters, true, 'SONAR curse must force broadcast');
  console.log('  ✓ SONAR curse forces immediate hunter broadcast');

  // 1.10 GPX Export verification
  const gpxExport = gameManager.exportGpx(testGameId);
  assert.strictEqual(gpxExport.success, true);
  assert.ok(gpxExport.gpx?.includes('<gpx version="1.1"'), 'GPX must contain standard header');
  assert.ok(gpxExport.gpx?.includes('lat="43.6045000"'), 'GPX must contain recorded coordinates');
  console.log('  ✓ GPX export properly generated valid XML');

  // ==========================================
  // INTEGRATION TESTS: Socket.IO Server & Client
  // ==========================================
  console.log('\n[2] Testing Socket.IO Integration...');

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

  const runnerClient: TestClientSocket = Client(socketUrl, { autoConnect: true });
  const hunterClient: TestClientSocket = Client(socketUrl, { autoConnect: true });

  await Promise.all([
    new Promise<void>((res) => runnerClient.on('connect', () => res())),
    new Promise<void>((res) => hunterClient.on('connect', () => res())),
  ]);
  console.log(`  ✓ Both client sockets connected to port ${port}`);

  const liveGameId = 'game_live_tour';

  // 2.1 Join Game
  const runnerJoinPromise = new Promise<GameState>((resolve) => {
    runnerClient.emit('join_game', { gameId: liveGameId, role: 'RUNNER', name: 'Adam' }, (resp) => {
      resolve(resp.state!);
    });
  });
  const hunterJoinPromise = new Promise<GameState>((resolve) => {
    hunterClient.emit('join_game', { gameId: liveGameId, role: 'HUNTER', name: 'Toby' }, (resp) => {
      resolve(resp.state!);
    });
  });

  const [runnerState, hunterState] = await Promise.all([runnerJoinPromise, hunterJoinPromise]);
  assert.strictEqual(runnerState.gameId, liveGameId);
  assert.strictEqual(hunterState.coins, 250);
  console.log('  ✓ Sockets successfully joined rooms and received initial game state');

  // 2.2 Transit Start via Socket
  const transitStartPromise = new Promise<GameState>((resolve) => {
    runnerClient.emit('transit_start', { gameId: liveGameId, mode: 'TELEO' }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve(resp.state!);
    });
  });
  const startedState = await transitStartPromise;
  assert.strictEqual(startedState.activeTransit?.mode, 'TELEO');
  console.log('  ✓ Socket transit_start handled successfully (TELEO, 25 coins/min)');

  // 2.3 Ping GPS via Socket
  const hunterPingPromise = new Promise<HunterPing>((resolve) => {
    hunterClient.on('hunter_ping', (ping) => resolve(ping));
  });

  await new Promise<void>((resolve) => {
    runnerClient.emit('ping_gps', { gameId: liveGameId, lat: 43.5594, lng: 1.4402 }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve();
    });
  });

  const receivedHunterPing = await hunterPingPromise;
  assert.strictEqual(receivedHunterPing.lat, 43.5594);
  console.log('  ✓ Socket ping_gps received by Runner and broadcasted to Hunter');

  // 2.4 Transit Stop via Socket
  const transitStopPromise = new Promise<TransitReport>((resolve) => {
    runnerClient.emit('transit_stop', { gameId: liveGameId }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve(resp.report!);
    });
  });
  const report = await transitStopPromise;
  assert.strictEqual(report.mode, 'TELEO');
  console.log(`  ✓ Socket transit_stop finished. Coins deducted: ${report.coinsDeducted}`);

  // 2.5 Export GPX via Socket
  const gpxSocketPromise = new Promise<string>((resolve) => {
    runnerClient.emit('export_gpx', { gameId: liveGameId }, (resp) => {
      assert.strictEqual(resp.success, true);
      resolve(resp.gpx!);
    });
  });
  const gpxContent = await gpxSocketPromise;
  assert.ok(gpxContent.includes('<trkpt lat="43.5594000" lon="1.4402000">'));
  console.log('  ✓ Socket export_gpx returned valid GPX content');

  // Cleanup
  runnerClient.disconnect();
  hunterClient.disconnect();
  io.close();
  server.close();

  console.log('\n=========================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! (10/10)');
  console.log('=========================================\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
