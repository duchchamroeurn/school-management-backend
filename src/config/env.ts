// Server settings, read from the environment and checked once at startup. Every problem is reported
// together and the process exits, so a misconfigured server never starts. See .env.example for each setting.
// server.ts loads .env before this module runs.
//
// Settings only the seed/demo scripts use (SEED_ADMIN_*, DEMO_PASSWORD) are read by those scripts, so they
// can run without the server's secrets.
import jwt from 'jsonwebtoken';
import { isSchoolLevel } from '../constants/school-levels';
import { SchoolLevel } from '../generated/prisma/client';

const env = process.env;
const problems: string[] = [];

function required(name: string) {
  const value = env[name]?.trim();
  if (!value) problems.push(`${name} is required`);
  return value ?? '';
}

function int(name: string, fallback: number, min = 1, max?: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `of at least ${min}` : `between ${min} and ${max}`;
    problems.push(`${name} must be a whole number ${range} (got "${raw}")`);
    return fallback;
  }
  return n;
}

// ── Database ──────────────────────────────────────────────
const databaseUrl = required('DATABASE_URL');
if (databaseUrl) {
  let protocol = '';
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    problems.push('DATABASE_URL is not a valid URL, e.g. postgresql://user:password@localhost:5432/school_management');
  }
  if (protocol && protocol !== 'postgresql:' && protocol !== 'postgres:') {
    problems.push(`DATABASE_URL must start with postgresql:// (got ${protocol}//)`);
  }
}

// ── Authentication ────────────────────────────────────────
const JWT_SECRET_MIN_LENGTH = 32;
// Example values from docs that must never be used for real (also listed in utils/generate-jwt-secret.ts)
const PLACEHOLDER_SECRETS = ['change-me-to-a-long-random-string', 'replace-with-output-of-openssl-rand-base64-48'];

const jwtSecret = required('JWT_SECRET');
if (jwtSecret) {
  if (PLACEHOLDER_SECRETS.includes(jwtSecret)) {
    problems.push('JWT_SECRET is still the example value; run: npm run jwt:secret');
  } else if (jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    problems.push(`JWT_SECRET must be at least ${JWT_SECRET_MIN_LENGTH} characters; run: npm run jwt:secret`);
  } else if (new Set(jwtSecret).size < 10) {
    problems.push('JWT_SECRET is too repetitive to be secure; run: npm run jwt:secret');
  }
}

const jwtExpiresIn = env.JWT_EXPIRES_IN?.trim() || '8h';
// jsonwebtoken reads a string without a unit as milliseconds ("8" = 8ms), so insist on one
if (!/^\d+(\.\d+)?\s*[a-z]+$/i.test(jwtExpiresIn) || !isValidExpiry(jwtExpiresIn)) {
  problems.push(`JWT_EXPIRES_IN must be a duration with a unit, e.g. 30m, 8h or 7d (got "${jwtExpiresIn}")`);
}

function isValidExpiry(expiresIn: string) {
  try {
    jwt.sign({}, 'check', { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
    return true;
  } catch {
    return false;
  }
}

// ── HTTP ──────────────────────────────────────────────────
const port = int('PORT', 3000, 1, 65535);

// Browsers send origins without a trailing slash
const corsOrigins = required('CORS_ORIGINS')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
for (const origin of corsOrigins) {
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    // reported below
  }
  if (!parsed || parsed.origin !== origin) {
    problems.push(`CORS_ORIGINS entry "${origin}" must be an origin like https://school.example.com (scheme, host and optional port only)`);
  }
}

// ── Login throttling ──────────────────────────────────────
const login = {
  maxFailures: int('LOGIN_MAX_FAILURES', 5),
  lockMinutes: int('LOGIN_LOCK_MINUTES', 15),
  ipMaxFailures: int('LOGIN_IP_MAX_FAILURES', 30),
  ipWindowMinutes: int('LOGIN_IP_WINDOW_MINUTES', 15),
};

// ── Logging ───────────────────────────────────────────────
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const LOG_FORMATS = ['json', 'pretty'] as const;

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) {
    problems.push(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
    return fallback;
  }
  return raw as T;
}

const log = {
  level: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
  // json: one JSON object per line, for log collectors; pretty: readable lines for development
  format: oneOf('LOG_FORMAT', LOG_FORMATS, 'json'),
};

// ── School (first install only; afterwards the database is the source of truth) ──
const schoolLevel = env.SCHOOL_LEVEL?.trim();
if (schoolLevel && !isSchoolLevel(schoolLevel)) {
  problems.push(`SCHOOL_LEVEL must be one of ${Object.values(SchoolLevel).join(', ')} (got "${schoolLevel}")`);
}

if (problems.length) {
  console.error(`Invalid configuration — fix .env (see .env.example):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

export const config = {
  databaseUrl,
  jwtSecret,
  jwtExpiresIn: jwtExpiresIn as NonNullable<jwt.SignOptions['expiresIn']>,
  port,
  corsOrigins,
  login,
  log,
};
