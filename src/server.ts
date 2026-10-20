// Load .env before anything reads process.env
import 'dotenv/config';
// Exits with a list of problems if the settings are invalid
import { config } from './config/env';
import app from './app';
import { markShuttingDown } from './lib/lifecycle';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

// Docker waits 10s after SIGTERM before killing the process; finish before that
const SHUTDOWN_TIMEOUT_MS = 8000;

async function start() {
  // Fail now rather than on the first request if DATABASE_URL points at the wrong host, database or credentials
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // Prisma's message starts with the invocation; the cause is on the last line
    const reason = err instanceof Error ? err.message.trim().split('\n').pop() : String(err);
    logger.error('Cannot connect to the database in DATABASE_URL', { reason });
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    logger.info('Server started', { url: `http://localhost:${config.port}`, mode: 'on-premise' });
  });

  // Stop taking new connections, let in-flight requests finish, then close the database pool
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    markShuttingDown();
    logger.info('Shutting down', { signal });

    setTimeout(() => {
      logger.error('Requests still running after shutdown timeout; exiting anyway', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close(async (err) => {
      await prisma.$disconnect();
      if (err) logger.error('Error while closing the server', { err });
      logger.info('Shutdown complete');
      process.exit(err ? 1 : 0);
    });
    // Keep-alive connections with no request in flight would otherwise hold close() open
    server.closeIdleConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
