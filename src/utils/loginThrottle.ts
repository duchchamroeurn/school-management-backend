// Brute-force protection for POST /auth/login. Only failed attempts count, so users who type their password
// correctly are never slowed down, even when a whole school shares one IP.
//
//   - Per IP: after LOGIN_IP_MAX_FAILURES failures within LOGIN_IP_WINDOW_MINUTES, that IP is refused until the window ends.
//   - Per username: after LOGIN_MAX_FAILURES failures in a row, the username is locked for LOGIN_LOCK_MINUTES,
//     even with the right password. Unknown usernames are tracked the same way so a lock can't reveal which accounts exist.
//
// State is kept in memory: fine for this single-process server. Move it to Redis or the database if the API
// ever runs as several instances.
import { Errors } from '../constants/errors';

const positiveInt = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

const IP_MAX_FAILURES = positiveInt(process.env.LOGIN_IP_MAX_FAILURES, 30);
const IP_WINDOW_MS = positiveInt(process.env.LOGIN_IP_WINDOW_MINUTES, 15) * 60_000;
const MAX_FAILURES = positiveInt(process.env.LOGIN_MAX_FAILURES, 5);
const LOCK_MS = positiveInt(process.env.LOGIN_LOCK_MINUTES, 15) * 60_000;

interface Counter {
  failures: number;
  expiresAt: number; // the counter is forgotten after this
}

const ipCounters = new Map<string, Counter>();
const usernameCounters = new Map<string, Counter>();

const secondsUntil = (time: number) => Math.max(1, Math.ceil((time - Date.now()) / 1000));

function current(map: Map<string, Counter>, key: string) {
  const counter = map.get(key);
  if (counter && counter.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return counter;
}

// Throws if this IP or username may not try to log in right now. Call before checking the password.
export function assertLoginAllowed(ip: string, username: string) {
  const ipCounter = current(ipCounters, ip);
  if (ipCounter && ipCounter.failures >= IP_MAX_FAILURES) {
    throw Errors.TOO_MANY_LOGIN_ATTEMPTS(secondsUntil(ipCounter.expiresAt));
  }
  const userCounter = current(usernameCounters, username);
  if (userCounter && userCounter.failures >= MAX_FAILURES) {
    throw Errors.ACCOUNT_LOCKED(secondsUntil(userCounter.expiresAt));
  }
}

// Records a wrong username/password. Throws ACCOUNT_LOCKED if this failure triggered the lock.
export function recordLoginFailure(ip: string, username: string) {
  const now = Date.now();

  const ipCounter = current(ipCounters, ip) ?? { failures: 0, expiresAt: now + IP_WINDOW_MS };
  ipCounter.failures++;
  ipCounters.set(ip, ipCounter);

  // Each failure pushes the expiry out, so failures spread over time still add up until a quiet LOCK_MS passes
  const userCounter = current(usernameCounters, username) ?? { failures: 0, expiresAt: 0 };
  userCounter.failures++;
  userCounter.expiresAt = now + LOCK_MS;
  usernameCounters.set(username, userCounter);

  if (userCounter.failures >= MAX_FAILURES) {
    throw Errors.ACCOUNT_LOCKED(secondsUntil(userCounter.expiresAt));
  }
}

// A correct password clears the username's failures (the IP counter is left to expire on its own)
export function recordLoginSuccess(username: string) {
  usernameCounters.delete(username);
}

// Drop expired counters so the maps don't grow with every username an attacker tries
setInterval(() => {
  const now = Date.now();
  for (const map of [ipCounters, usernameCounters]) {
    for (const [key, counter] of map) {
      if (counter.expiresAt <= now) map.delete(key);
    }
  }
}, 60_000).unref();
