// The school calendar: the normal school week (which shifts are taught on each weekday) and calendar entries —
// public holidays, school breaks, school events and make-up days.
//
// Whether a shift on a date is taught:
//   1. the school week for that weekday,
//   2. opened by a make-up day covering it,
//   3. closed by any entry that closes the school (holiday, break, or an event with closesSchool) — this wins.
// An entry with a shift covers only that shift; without one, the whole day.
import { Errors } from '../constants/errors';
import { CalendarEvent, CalendarEventType, Prisma, Shift } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { isoDate } from '../utils/dates';
import { audit, scalars } from './audit.service';

export const MAX_EVENT_DAYS = 366;
export const MAX_RANGE_DAYS = 400;

// Monday–Saturday mornings, Monday–Friday afternoons: the usual Cambodian secondary school week
const DEFAULT_WEEK = [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, morning: dayOfWeek <= 6, afternoon: dayOfWeek <= 5 }));

const SHIFT_KEY = { [Shift.MORNING]: 'morning', [Shift.AFTERNOON]: 'afternoon' } as const;

export interface WeekdayInput {
  dayOfWeek: number;
  morning: boolean;
  afternoon: boolean;
}

export interface CalendarEventInput {
  type: CalendarEventType;
  khmerName: string;
  latinName?: string | null;
  startDate: Date;
  endDate: Date;
  shift?: Shift | null;
  closesSchool?: boolean;
  recursYearly?: boolean;
  notes?: string | null;
}

export interface CalendarEventFilter {
  from?: Date;
  to?: Date;
  type?: CalendarEventType;
}

const DAY_MS = 86_400_000;
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
/** 1 = Monday … 7 = Sunday */
const weekdayOf = (date: Date) => date.getUTCDay() || 7;

// ── School week ──────────────────────────────────────────────────────────

/** The seven weekdays, Monday first. Created with the default week on first use. */
export async function getSchoolWeek(db: Prisma.TransactionClient = prisma) {
  const rows = await db.schoolWeekday.findMany({ orderBy: { dayOfWeek: 'asc' } });
  if (rows.length === 7) return rows;
  await db.schoolWeekday.createMany({ data: DEFAULT_WEEK.filter((d) => !rows.some((r) => r.dayOfWeek === d.dayOfWeek)), skipDuplicates: true });
  return db.schoolWeekday.findMany({ orderBy: { dayOfWeek: 'asc' } });
}

export async function updateSchoolWeek(weekdays: WeekdayInput[]) {
  const days = new Set(weekdays.map((d) => d.dayOfWeek));
  if (weekdays.length !== 7 || days.size !== 7 || [...days].some((d) => d < 1 || d > 7)) throw Errors.SCHOOL_WEEK_INVALID();
  if (!weekdays.some((d) => d.morning || d.afternoon)) throw Errors.SCHOOL_WEEK_EMPTY();

  return prisma.$transaction(async (tx) => {
    const before = await getSchoolWeek(tx);
    for (const { dayOfWeek, morning, afternoon } of weekdays) {
      await tx.schoolWeekday.update({ where: { dayOfWeek }, data: { morning, afternoon } });
    }
    const after = await getSchoolWeek(tx);
    const snapshot = (rows: WeekdayInput[]) => Object.fromEntries(rows.map((r) => [r.dayOfWeek, { morning: r.morning, afternoon: r.afternoon }]));
    await audit(tx, {
      entityType: 'SchoolWeek',
      action: 'SCHOOL_WEEK_UPDATED',
      entityId: 'school-week',
      entityLabel: 'School week',
      before: snapshot(before),
      after: snapshot(after),
    });
    return after;
  });
}

// ── Calendar entries ─────────────────────────────────────────────────────

/** Holidays and breaks always close the school; make-up days never do; events only when asked to. */
function closesSchoolFor(type: CalendarEventType, requested: boolean | undefined) {
  if (type === CalendarEventType.PUBLIC_HOLIDAY || type === CalendarEventType.SCHOOL_BREAK) return true;
  if (type === CalendarEventType.MAKEUP_DAY) return false;
  return requested ?? false;
}

function checkEvent(event: Pick<CalendarEventInput, 'type' | 'startDate' | 'endDate' | 'recursYearly'>) {
  if (event.endDate < event.startDate) throw Errors.CALENDAR_DATES_INVALID();
  if (daysBetween(event.startDate, event.endDate) + 1 > MAX_EVENT_DAYS) throw Errors.CALENDAR_EVENT_TOO_LONG(MAX_EVENT_DAYS);
  if (event.recursYearly) {
    const sameYear = event.startDate.getUTCFullYear() === event.endDate.getUTCFullYear();
    // 29 February has no date to repeat on in most years
    const leapDay = (d: Date) => d.getUTCMonth() === 1 && d.getUTCDate() === 29;
    if (event.type !== CalendarEventType.PUBLIC_HOLIDAY || !sameYear || leapDay(event.startDate) || leapDay(event.endDate)) {
      throw Errors.CALENDAR_RECURRING_INVALID();
    }
  }
}

const auditEvent = (e: { id: string; khmerName: string; startDate: Date }) =>
  ({ entityType: 'CalendarEvent', entityId: e.id, entityLabel: `${e.khmerName} (${isoDate(e.startDate)})` }) as const;

/**
 * Entries overlapping from–to (either may be left out), plus every entry that repeats yearly, which shows
 * under its first year's dates. Ordered by start date.
 */
export function listEvents(filter: CalendarEventFilter = {}) {
  const overlap: Prisma.CalendarEventWhereInput = {
    ...(filter.to && { startDate: { lte: filter.to } }),
    ...(filter.from && { endDate: { gte: filter.from } }),
  };
  return prisma.calendarEvent.findMany({
    where: { ...(filter.type && { type: filter.type }), OR: [overlap, { recursYearly: true }] },
    orderBy: [{ startDate: 'asc' }, { khmerName: 'asc' }],
  });
}

export async function createEvent(input: CalendarEventInput) {
  const data = { ...input, closesSchool: closesSchoolFor(input.type, input.closesSchool), recursYearly: input.recursYearly ?? false };
  checkEvent(data);
  return prisma.$transaction(async (tx) => {
    const created = await tx.calendarEvent.create({ data });
    await audit(tx, { ...auditEvent(created), action: 'CALENDAR_EVENT_CREATED', after: scalars(created) });
    return created;
  });
}

export async function updateEvent(id: string, input: Partial<CalendarEventInput>) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.calendarEvent.findUnique({ where: { id } });
    if (!current) throw Errors.CALENDAR_EVENT_NOT_FOUND();
    const merged = { ...current, ...stripUndefined(input) };
    const data = { ...stripUndefined(input), closesSchool: closesSchoolFor(merged.type, input.closesSchool ?? current.closesSchool) };
    checkEvent({ ...merged, ...data });
    const updated = await tx.calendarEvent.update({ where: { id }, data });
    await audit(tx, { ...auditEvent(updated), action: 'CALENDAR_EVENT_UPDATED', before: scalars(current), after: scalars(updated) });
    return updated;
  });
}

export async function deleteEvent(id: string) {
  await prisma.$transaction(async (tx) => {
    const event = await tx.calendarEvent.findUnique({ where: { id } });
    if (!event) throw Errors.CALENDAR_EVENT_NOT_FOUND();
    await tx.calendarEvent.delete({ where: { id } });
    await audit(tx, { ...auditEvent(event), action: 'CALENDAR_EVENT_DELETED', before: scalars(event) });
  });
}

function stripUndefined<T extends object>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Working out school days ──────────────────────────────────────────────

interface Occurrence {
  event: CalendarEvent;
  startDate: Date;
  endDate: Date;
}

/** Entries covering any day of from–to, with yearly holidays moved to each year they fall in (from their first year on). */
async function occurrencesBetween(db: Prisma.TransactionClient, from: Date, to: Date): Promise<Occurrence[]> {
  const events = await db.calendarEvent.findMany({
    where: { OR: [{ startDate: { lte: to }, endDate: { gte: from } }, { recursYearly: true, startDate: { lte: to } }] },
    orderBy: { startDate: 'asc' },
  });
  const occurrences: Occurrence[] = [];
  for (const event of events) {
    if (!event.recursYearly) {
      occurrences.push({ event, startDate: event.startDate, endDate: event.endDate });
      continue;
    }
    const firstYear = event.startDate.getUTCFullYear();
    for (let year = Math.max(firstYear, from.getUTCFullYear()); year <= to.getUTCFullYear(); year++) {
      const move = (d: Date) => new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));
      const startDate = move(event.startDate);
      const endDate = move(event.endDate);
      if (startDate <= to && endDate >= from) occurrences.push({ event, startDate, endDate });
    }
  }
  return occurrences;
}

const covers = (o: Occurrence, date: Date, shift: Shift) => o.startDate <= date && o.endDate >= date && (!o.event.shift || o.event.shift === shift);

/** Is the shift taught on the date, and if not, why */
function shiftStatus(week: Map<number, WeekdayInput>, occurrences: Occurrence[], date: Date, shift: Shift) {
  const covering = occurrences.filter((o) => covers(o, date, shift));
  const closing = covering.find((o) => o.event.closesSchool);
  if (closing) return { open: false, closedBy: closing.event };
  if (covering.some((o) => o.event.type === CalendarEventType.MAKEUP_DAY)) return { open: true, closedBy: null };
  return { open: Boolean(week.get(weekdayOf(date))?.[SHIFT_KEY[shift]]), closedBy: null };
}

/**
 * Every date from–to (inclusive, at most MAX_RANGE_DAYS) with whether each shift is taught and the entries on
 * that date, plus totals: school days (at least one shift taught) and days the week would teach but an entry closed.
 */
export async function getCalendar(from: Date, to: Date) {
  if (to < from) throw Errors.CALENDAR_DATES_INVALID();
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw Errors.CALENDAR_RANGE_TOO_LONG(MAX_RANGE_DAYS);

  const [weekRows, occurrences] = await Promise.all([getSchoolWeek(), occurrencesBetween(prisma, from, to)]);
  const week = new Map(weekRows.map((d) => [d.dayOfWeek, d]));

  const days = [];
  const summary = { days: 0, schoolDays: 0, morningDays: 0, afternoonDays: 0, closedSchoolDays: 0 };
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const morning = shiftStatus(week, occurrences, date, Shift.MORNING);
    const afternoon = shiftStatus(week, occurrences, date, Shift.AFTERNOON);
    const usual = week.get(weekdayOf(date));
    const events = occurrences
      .filter((o) => o.startDate <= date && o.endDate >= date)
      .map((o) => ({
        id: o.event.id,
        type: o.event.type,
        khmerName: o.event.khmerName,
        latinName: o.event.latinName,
        shift: o.event.shift,
        closesSchool: o.event.closesSchool,
      }));

    summary.days += 1;
    if (morning.open || afternoon.open) summary.schoolDays += 1;
    if (morning.open) summary.morningDays += 1;
    if (afternoon.open) summary.afternoonDays += 1;
    if ((usual?.morning || usual?.afternoon) && !morning.open && !afternoon.open) summary.closedSchoolDays += 1;

    days.push({ date: isoDate(date), dayOfWeek: weekdayOf(date), morning: morning.open, afternoon: afternoon.open, events });
  }
  return { from: isoDate(from), to: isoDate(to), weekdays: weekRows, days, summary };
}

/**
 * Counts school days in date ranges within from–to, loading the school week and calendar entries once, so a
 * page of leave requests costs two queries. With a shift, a day counts when that shift is taught; without
 * one (e.g. a student not in any class), when either shift is.
 */
export async function schoolDayCounter(db: Prisma.TransactionClient, from: Date, to: Date) {
  const [weekRows, occurrences] = await Promise.all([getSchoolWeek(db), occurrencesBetween(db, from, to)]);
  const week = new Map(weekRows.map((d) => [d.dayOfWeek, d]));
  const taught = (date: Date, shift: Shift) => shiftStatus(week, occurrences, date, shift).open;

  return (start: Date, end: Date, shift: Shift | null) => {
    let count = 0;
    for (let date = start; date <= end; date = addDays(date, 1)) {
      if (shift ? taught(date, shift) : taught(date, Shift.MORNING) || taught(date, Shift.AFTERNOON)) count += 1;
    }
    return count;
  };
}

/**
 * Whether the shift is taught on the date. When not, `reason` names the entry that closed it, or says the
 * school week has no classes then. Used to refuse attendance on days without school.
 */
export async function schoolDayStatus(db: Prisma.TransactionClient, date: Date, shift: Shift) {
  const [weekRows, occurrences] = await Promise.all([getSchoolWeek(db), occurrencesBetween(db, date, date)]);
  const status = shiftStatus(new Map(weekRows.map((d) => [d.dayOfWeek, d])), occurrences, date, shift);
  const reason = status.open ? null : status.closedBy ? status.closedBy.latinName || status.closedBy.khmerName : `no ${shift.toLowerCase()} classes on this weekday`;
  return { open: status.open, reason, closedBy: status.closedBy };
}

/**
 * Whether a class has lessons on the date. A half-day class follows its shift; a full-day class (shift null) has
 * school when either shift is taught, e.g. Saturday morning. When neither is, closedBy names the entry that closed
 * the day, if one did.
 */
export async function classDayStatus(db: Prisma.TransactionClient, date: Date, shift: Shift | null) {
  if (shift) return schoolDayStatus(db, date, shift);
  const [morning, afternoon] = await Promise.all([schoolDayStatus(db, date, Shift.MORNING), schoolDayStatus(db, date, Shift.AFTERNOON)]);
  if (morning.open || afternoon.open) return { open: true, reason: null, closedBy: null };
  const closedBy = morning.closedBy ?? afternoon.closedBy;
  return { open: false, reason: closedBy ? closedBy.latinName || closedBy.khmerName : 'no classes on this weekday', closedBy };
}
