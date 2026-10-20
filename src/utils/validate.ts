// Small request-validation helpers. Each `optional*` returns undefined when the field is absent
// (meaning "don't change" for PATCH); `required` turns absence into a 400.
import { Request } from 'express';
import { Errors } from '../constants/errors';

const invalid = (field: string, message: string) =>
  Errors.INVALID_FIELD(field, message);

export const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

export function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw invalid(field, 'is required');
  return value;
}

export function optionalString(value: unknown, field: string, maxLength = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw invalid(field, 'must be a non-empty string');
  if (value.trim().length > maxLength) throw invalid(field, `must be at most ${maxLength} characters`);
  return value.trim();
}

// undefined = not provided, null (or "") = clear the value
export function nullableString(value: unknown, field: string): string | null | undefined {
  if (value === null || value === '') return null;
  return optionalString(value, field);
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number between ${min} and ${max}`);
  }
  return value;
}

// Accepts "YYYY-MM-DD" only, stored as UTC midnight (columns are DATE)
export function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(field, 'must be a date in YYYY-MM-DD format');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid(field, 'is not a valid date');
  return date;
}

export function optionalEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid(field, `must be one of ${allowed.join(', ')}`);
  return value as T;
}

// Khmer Unicode block U+1780–U+17FF (plus spaces / common punctuation)
export function optionalKhmerName(value: unknown, field = 'khmerName'): string | undefined {
  const name = optionalString(value, field);
  if (name !== undefined && !/^[ក-៿᧠-᧿\s.\-]+$/.test(name)) {
    throw invalid(field, 'must be written in Khmer script');
  }
  return name?.replace(/\s+/g, ' ');
}

// Romanised name: Latin letters (incl. accents), spaces, hyphens, apostrophes, dots
export function optionalLatinName(value: unknown, field = 'latinName'): string | undefined {
  const name = optionalString(value, field);
  if (name !== undefined && !/^[A-Za-zÀ-ÖØ-öø-ÿ\s'.\-]+$/.test(name)) {
    throw invalid(field, 'must contain Latin letters only');
  }
  return name?.replace(/\s+/g, ' ');
}

// Official document numbers (e.g. birth certificate "១២៣/២០១៣"). Normalised so the same document
// can't be stored twice in different spellings: Khmer digits → 0-9, spaces removed, upper-case.
const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
export function optionalDocumentNumber(value: unknown, field: string): string | undefined {
  const raw = optionalString(value, field, 50);
  if (raw === undefined) return undefined;
  const normalised = raw
    .replace(/[០-៩]/g, (d) => String(KHMER_DIGITS.indexOf(d)))
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!/^[A-Z0-9/.\-]+$/.test(normalised) || !/[0-9]/.test(normalised)) {
    throw invalid(field, 'must contain digits and only letters, digits, "/", "-" or "."');
  }
  return normalised;
}

// Cambodian phone number, normalised to local format: "+855 12 345 678" / "012-345-678" → "012345678"
export function nullablePhone(value: unknown, field = 'phone'): string | null | undefined {
  const raw = nullableString(value, field);
  if (raw == null) return raw;
  const digits = raw.replace(/[\s\-().]/g, '').replace(/^\+?855/, '0');
  if (!/^0\d{8,9}$/.test(digits)) throw invalid(field, 'must be a Cambodian phone number, e.g. 012345678 or +85512345678');
  return digits;
}

// Telegram username, stored with a leading "@"
export function nullableTelegramHandle(value: unknown, field = 'telegramHandle'): string | null | undefined {
  const raw = nullableString(value, field);
  if (raw == null) return raw;
  const handle = raw.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(handle)) throw invalid(field, 'must be 5–32 letters, digits or underscores');
  return `@${handle}`;
}

// Login username: 3–32 chars, lower-cased; letters, digits, ".", "_", "-"
export function optionalUsername(value: unknown, field = 'username'): string | undefined {
  const name = optionalString(value, field, 32)?.toLowerCase();
  if (name !== undefined && !/^[a-z0-9._-]{3,32}$/.test(name)) {
    throw invalid(field, 'must be 3–32 characters: letters, digits, ".", "_" or "-"');
  }
  return name;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw invalid(field, 'must be an array of non-empty strings');
  }
  return [...new Set(value.map((v: string) => v.trim()))];
}

// A score: a JSON number, not negative, at most two decimals (e.g. 8, 7.5, 12.25). The upper limit
// depends on the subject's rules for the month, so the service checks it.
export function optionalScore(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid(field, 'must be a number of at least 0');
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw invalid(field, 'must have at most two decimals');
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(field, 'must be true or false');
  return value;
}

// "true" / "false" in a query string
export function queryBoolean(value: unknown, field: string): boolean | undefined {
  const raw = queryString(value, field);
  if (raw === undefined) return undefined;
  if (raw !== 'true' && raw !== 'false') throw invalid(field, 'must be true or false');
  return raw === 'true';
}

// Short stable identifier such as "MATH" or "EARTH_SCIENCE" (upper-cased)
export function optionalCode(value: unknown, field = 'code'): string | undefined {
  const code = optionalString(value, field, 30)?.toUpperCase();
  if (code !== undefined && !/^[A-Z][A-Z0-9_]{1,29}$/.test(code)) {
    throw invalid(field, 'must be 2–30 characters: letters, digits or "_", starting with a letter');
  }
  return code;
}

// ?page=1&pageSize=20 → { skip, take, page, pageSize }
export function pagination(query: Record<string, unknown>, maxPageSize = 100) {
  const toInt = (value: unknown, field: string, fallback: number, max: number) => {
    const raw = queryString(value, field);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(field, `must be a whole number between 1 and ${max}`);
    return n;
  };
  const page = toInt(query.page, 'page', 1, 100_000);
  const pageSize = toInt(query.pageSize, 'pageSize', 20, maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// Query-string params arrive as string | string[]; only accept a single string
export function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, 'must be a single value');
  return optionalString(value, field);
}
