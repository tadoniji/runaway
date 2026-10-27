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
    activeGamesCount: gameManager.listGames().length,
  });
});

/**
 * List all active games (overview)
 */
apiRouter.get('/api/games', (_req: Request, res: Response) => {
  const games = gameManager.listGames().map((id) => {
    const game = gameManager.getGame(id);
    return {
      gameId: id,
      status: game?.status,
      coins: game?.coins,
      playersCount: Object.keys(game?.players || {}).length,
      historyCount: game?.history.length || 0,
      createdAt: game?.createdAt,
    };
  });

  res.json({ games });
});

/**
 * Get full state of a specific game
 */
apiRouter.get('/api/games/:gameId', (req: Request, res: Response) => {
  const gameId = String(req.params.gameId);
  const game = gameManager.getGame(gameId);

  if (!game) {
    return res.status(404).json({ error: `Game "${gameId}" not found.` });
  }

  return res.json({ game });
});

/**
 * Export GPX file as downloadable attachment
 */
apiRouter.get('/api/games/:gameId/gpx', (req: Request, res: Response) => {
  const gameId = String(req.params.gameId);
  const result = gameManager.exportGpx(gameId);

  if (!result.success || !result.gpx) {
    return res.status(404).json({ error: result.error || 'GPX track not found.' });
  }

  const filename = result.filename || `runaway_${gameId}.gpx`;

  res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(result.gpx);
});
