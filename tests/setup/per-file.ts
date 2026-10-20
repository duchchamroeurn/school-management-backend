import { afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma';

// Each test file gets its own Prisma client instance; close it so the run can exit
afterAll(async () => {
  await prisma.$disconnect();
});
