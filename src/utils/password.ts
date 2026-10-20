import bcrypt from 'bcrypt';
import { randomInt } from 'node:crypto';

const BCRYPT_ROUNDS = 12;

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);

export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Real hash of a random value; compared against when a username doesn't exist,
// so login takes the same time whether or not the account exists
export const DUMMY_HASH = bcrypt.hashSync(crypto.randomUUID(), BCRYPT_ROUNDS);

// Returns a list of unmet rules (empty = valid)
export function checkPasswordPolicy(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 8) problems.push('at least 8 characters');
  if (password.length > 72) problems.push('at most 72 characters'); // bcrypt ignores bytes past 72
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
  return problems;
}

// Look-alike characters (0/O, 1/l/I) left out so temporary passwords can be read out or written down
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';

/** Cryptographically random 12-character password that always satisfies checkPasswordPolicy. */
export function generateTemporaryPassword(length = 12): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates shuffle so the guaranteed characters aren't always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
