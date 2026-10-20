// Generates a random JWT_SECRET and writes it into .env (creating .env from .env.example if needed).
//
//   npm run jwt:secret              # set JWT_SECRET in .env, unless it already holds a real secret
//   npm run jwt:secret -- --force   # replace the existing secret (logs everyone out)
//   npm run jwt:secret -- --print   # only print a secret, change nothing
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
const EXAMPLE_PATH = resolve(process.cwd(), '.env.example');
// Must match PLACEHOLDER_SECRETS in src/config/env.ts
const PLACEHOLDERS = ['', 'change-me-to-a-long-random-string', 'replace-with-output-of-openssl-rand-base64-48'];

const args = process.argv.slice(2);
// 48 random bytes → 64 URL-safe characters, nothing that needs quoting in .env
const secret = randomBytes(48).toString('base64url');

if (args.includes('--print')) {
  console.log(secret);
  process.exit(0);
}

if (!existsSync(ENV_PATH)) {
  if (existsSync(EXAMPLE_PATH)) {
    copyFileSync(EXAMPLE_PATH, ENV_PATH);
    console.log('Created .env from .env.example');
  } else {
    writeFileSync(ENV_PATH, '');
  }
}

const content = readFileSync(ENV_PATH, 'utf8');
const line = /^[ \t]*JWT_SECRET[ \t]*=(.*)$/m;
const match = content.match(line);
const current = match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2') ?? '';

const hadSecret = !PLACEHOLDERS.includes(current);
if (hadSecret && !args.includes('--force')) {
  console.error('.env already has a JWT_SECRET. Replacing it logs everyone out; run with --force to do it anyway.');
  process.exit(1);
}

const updated = match
  ? content.replace(line, `JWT_SECRET=${secret}`)
  : `${content}${content && !content.endsWith('\n') ? '\n' : ''}JWT_SECRET=${secret}\n`;
writeFileSync(ENV_PATH, updated);
console.log(hadSecret ? 'Replaced JWT_SECRET in .env' : 'Set JWT_SECRET in .env');
