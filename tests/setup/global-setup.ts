// Runs once before the test files: prepares an empty, seeded test database.
//   1. refuses to touch any database whose name doesn't end in "_test"
//   2. drops and recreates that database, then pushes the Prisma schema to it
//   3. runs the real seed (roles, permissions, grades 7–12, subjects, admin, time slots)
//   4. adds the academic years the tests build on: 2025-2026 COMPLETED, 2026-2027 ACTIVE, 2027-2028 UPCOMING
import { execSync } from 'node:child_process';
import { Client } from 'pg';

export function assertTestDatabase(url: string | undefined) {
  const name = url && new URL(url).pathname.slice(1);
  if (!name?.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${name}": the test database name must end in "_test" (set TEST_DATABASE_URL)`);
  }
  return name;
}

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://school:school@localhost:5432/school_management_test';
  const name = assertTestDatabase(url);
  const env = { ...process.env, DATABASE_URL: url, SCHOOL_LEVEL: 'COMBINED', SEED_ADMIN_PASSWORD: 'Admin@12345!' };

  // Recreate the test database from scratch (connected to the server's default database to do it). A fresh
  // database means the schema push never meets old rows, so it needs no data-loss confirmation.
  const server = new URL(url);
  server.pathname = '/postgres';
  const admin = new Client({ connectionString: server.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  execSync('npx prisma db push --config prisma7.config.ts', { env, stdio: 'pipe' });

  execSync('npx tsx src/utils/seed.ts', { env, stdio: 'pipe' });

  const years = new Client({ connectionString: url });
  await years.connect();
  await years.query(`
    INSERT INTO academic_years (id, name, start_date, end_date, status) VALUES
      (gen_random_uuid(), '2025-2026', '2025-11-01', '2026-08-31', 'COMPLETED'),
      (gen_random_uuid(), '2026-2027', '2026-11-01', '2027-08-31', 'ACTIVE'),
      (gen_random_uuid(), '2027-2028', '2027-11-01', '2028-08-31', 'UPCOMING')`);
  await years.end();
}
