import { Request, Response, Router } from 'express';
import { Errors } from '../constants/errors';
import { isShuttingDown } from '../lib/lifecycle';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';

const router = Router();

// A hung connection must not hang the health check: give up after this long
const DATABASE_TIMEOUT_MS = 3000;

async function databaseReachable() {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${DATABASE_TIMEOUT_MS}ms`)), DATABASE_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/v1/health — 200 only when the API can serve requests: not shutting down and the database answers.
// Load balancers and monitoring should treat 503 as down.
router.get('/', async (_req: Request, res: Response) => {
  if (isShuttingDown()) throw Errors.SHUTTING_DOWN();
  try {
    await databaseReachable();
  } catch (err) {
    logger.error('Health check: database unreachable', { err });
    throw Errors.DATABASE_UNAVAILABLE();
  }
  res.status(200).json({ status: 'success', message: 'School System API is running.', database: 'up' });
});

export default router;
