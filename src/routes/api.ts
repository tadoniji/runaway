import { Request, Response, Router } from 'express';
import { GameManager } from '../GameManager';

export const apiRouter = Router();
const gameManager = GameManager.getInstance();

/**
 * Healthcheck route for Render Web Service monitoring
 */
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeGamesCount: gameManager.listSessions().length,
  });
});

/**
 * List all active games overview
 */
apiRouter.get('/api/games', (_req: Request, res: Response) => {
  const games = gameManager.listSessions().map((code: string) => {
    const session = gameManager.getSession(code);
    return {
      gameCode: code,
      stage: session?.stage,
      hostId: session?.hostId,
      runnerId: session?.runnerId,
      runnerCoins: session?.runnerCoins,
      playersCount: session?.players.size || 0,
      historyCount: session?.history.length || 0,
      activeTransit: session?.activeTransit,
      jailTimeEndTime: session?.jailTimeEndTime,
      isEnded: session?.isEnded,
    };
  });

  res.json({ games });
});

/**
 * Get full state of a specific game
 */
apiRouter.get('/api/games/:gameCode', (req: Request, res: Response) => {
  const gameCode = String(req.params.gameCode);
  const session = gameManager.getSession(gameCode);

  if (!session) {
    return res.status(404).json({ error: `Game session "${gameCode}" not found.` });
  }

  const players: Record<string, any> = {};
  session.players.forEach((p, id) => {
    players[id] = p;
  });

  return res.json({
    session: {
      ...session,
      players,
    },
  });
});

/**
 * Export GPX file as downloadable attachment
 */
apiRouter.get('/api/games/:gameCode/gpx', (req: Request, res: Response) => {
  const gameCode = String(req.params.gameCode);
  const result = gameManager.exportGpx(gameCode);

  if (!result.success || !result.gpx) {
    return res.status(404).json({ error: result.error || 'GPX track not found.' });
  }

  const filename = result.filename || `runaway_${gameCode}.gpx`;

  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(result.gpx);
});
