import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Tests run against their own database, never the development one. Override with TEST_DATABASE_URL.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://school:school@localhost:5432/school_management_test';

// Files go to the development MinIO (docker compose up -d minio), in a bucket of their own. Only its login is
// taken from .env; override with TEST_S3_*.
const dotenv = existsSync('.env') ? parse(readFileSync('.env')) : {};
const s3 = (name: string, fallback: string) => process.env[`TEST_${name}`] ?? dotenv[name] ?? fallback;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/per-file.ts'],
    // Every variable the API reads, so .env (the development settings) is never what a test sees
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: randomBytes(48).toString('base64'),
      CORS_ORIGINS: 'http://localhost:5173',
      LOG_LEVEL: 'error',
      SCHOOL_LEVEL: 'COMBINED',
      S3_ENDPOINT: s3('S3_ENDPOINT', 'http://localhost:9000'),
      S3_ACCESS_KEY: s3('S3_ACCESS_KEY', 'school'),
      S3_SECRET_KEY: s3('S3_SECRET_KEY', ''),
      S3_BUCKET: 'school-files-test',
    },
    // One shared database: run the files one after another
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
