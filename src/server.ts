// Loaded first: exits with a list of problems if .env is invalid
import { config } from './config/env';
import app from './app';
import { prisma } from './lib/prisma';

async function start() {
  // Fail now rather than on the first request if DATABASE_URL points at the wrong host, database or credentials
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // Prisma's message starts with the invocation; the cause is on the last line
    const reason = err instanceof Error ? err.message.trim().split('\n').pop() : String(err);
    console.error(`Cannot connect to the database in DATABASE_URL: ${reason}`);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Server is running in on-premise mode on http://localhost:${config.port}`);
  });
}

start();
