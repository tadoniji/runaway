import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { apiRouter } from './routes/api';
import { setupSocketHandlers } from './socket';
import { GameManager } from './GameManager';
import {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './types';

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// Permissive CORS setup for Express (Android dev, emulators 10.0.2.2, Capacitor, Web)
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json());

// REST routes
app.use(apiRouter);

// Permissive CORS setup for Socket.IO
const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
  },
  pingTimeout: 30000,
  pingInterval: 25000,
});

// Attach game business logic handlers
setupSocketHandlers(io);

// Server port and host binding
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0'; // Essential for Render and cloud containers

server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log(`🚀 Runaway Authoritative Server is running!`);
  console.log(`📍 Listening on: http://${HOST}:${PORT}`);
  console.log(`📡 Socket.IO initialized with permissive CORS`);
  console.log(`🩺 Healthcheck: http://${HOST}:${PORT}/health`);
  console.log('====================================================');

  // Anti-sleep keepalive: when active games are running, ping self to keep cloud container awake
  setInterval(() => {
    try {
      const activeCount = GameManager.getInstance().listSessions().length;
      if (activeCount > 0) {
        http.get(`http://127.0.0.1:${PORT}/health`, () => {}).on('error', () => {});
      }
    } catch {
      // Ignore background keepalive error
    }
  }, 5 * 60 * 1000); // Every 5 minutes
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  io.close(() => {
    console.log('Socket.IO connections closed.');
    server.close(() => {
      console.log('HTTP server closed. Exiting process.');
      process.exit(0);
    });
  });

  // Force exit after 10s if dangling connections persist
  setTimeout(() => {
    console.error('Forcefully exiting after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, io };
