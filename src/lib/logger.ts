// Structured logger: one JSON object per line (LOG_FORMAT=json, the default) so logs can be searched and
// shipped to a collector, or readable lines for development (LOG_FORMAT=pretty). Entries written during a
// request carry its requestId automatically. Never log request bodies, passwords or tokens.
import { config } from '../config/env';
import { currentContext } from './requestContext';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Errors don't serialise to JSON on their own
const serialise = (value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

function write(level: Level, msg: string, fields: Fields = {}) {
  if (RANK[level] < RANK[config.log.level]) return;
  const requestId = currentContext()?.requestId;
  const entry: Fields = { time: new Date().toISOString(), level, msg, ...(requestId && { requestId }) };
  for (const [key, value] of Object.entries(fields)) entry[key] = serialise(value);

  const stream = RANK[level] >= RANK.warn ? process.stderr : process.stdout;
  if (config.log.format === 'json') {
    stream.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  const { time, level: _level, msg: _msg, ...rest } = entry;
  const stack = (rest.err as { stack?: string } | undefined)?.stack;
  if (stack) delete rest.err;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  stream.write(`${(time as string).slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n${stack ? `${stack}\n` : ''}`);
}

export const logger = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
