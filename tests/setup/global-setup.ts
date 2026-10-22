// Runs once before the test files: prepares an empty, seeded test database.
//   1. refuses to touch any database whose name doesn't end in "_test"
//   2. drops and recreates that database, then pushes the Prisma schema to it
//   3. runs the real seed (roles, permissions, grades 7–12, subjects, admin, time slots)
//   4. adds the academic years the tests build on: 2025-2026 COMPLETED, 2026-2027 ACTIVE, 2027-2028 UPCOMING
//   5. adds a small made-up gazetteer (province code 99, which doesn't exist in Cambodia) for student addresses
//   6. empties the test bucket in MinIO
import { execSync } from 'node:child_process';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { readStorageConfig } from '../../src/config/storage';

export function assertTestDatabase(url: string | undefined) {
  const name = url && new URL(url).pathname.slice(1);
  if (!name?.endsWith('_test')) {
    throw new Error(`Refusing to run tests against "${name}": the test database name must end in "_test" (set TEST_DATABASE_URL)`);
  }
  return name;
}

export default async function setup(project: TestProject) {
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
  await years.query(`
    INSERT INTO provinces (code, type, khmer_name, latin_name) VALUES ('99', 'PROVINCE', 'សាកល្បង', 'Sakalbang');
    INSERT INTO districts (code, province_code, type, khmer_name, latin_name) VALUES ('9901', '99', 'DISTRICT', 'ទីមួយ', 'Ti Muoy');
    INSERT INTO communes (code, district_code, type, khmer_name, latin_name) VALUES
      ('990101', '9901', 'COMMUNE', 'ព្រែក', 'Preaek'), ('990102', '9901', 'SANGKAT', 'ទួល', 'Tuol');
    INSERT INTO villages (code, commune_code, khmer_name, latin_name) VALUES
      ('99010101', '990101', 'កណ្ដាល', 'Kandal'), ('99010102', '990101', 'ត្បូង', 'Tboung'), ('99010201', '990102', 'ជើង', 'Cheung')`);
  await years.end();

  await emptyTestBucket(project.config.env);
}

// Leftovers of earlier runs; the bucket itself is created by the API on the first upload
async function emptyTestBucket(testEnv: NodeJS.ProcessEnv) {
  const { config, problems } = readStorageConfig(testEnv);
  if (problems.length) throw new Error(`Tests need MinIO (docker compose up -d minio) and its login in .env:\n  - ${problems.join('\n  - ')}`);
  if (!config.bucket.endsWith('-test')) throw new Error(`Refusing to empty bucket "${config.bucket}": the test bucket name must end in "-test"`);
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    forcePathStyle: true,
  });
  try {
    for (;;) {
      const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket }));
      if (!Contents?.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }));
    }
  } catch (err) {
    if ((err as { name?: string }).name !== 'NoSuchBucket') throw new Error(`Tests need MinIO at ${config.endpoint} (docker compose up -d minio): ${err}`);
  } finally {
    s3.destroy();
  }
}
