import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { CalendarEventType, Shift } from '../generated/prisma/client';
import * as calendarService from '../services/calendar.service';
import { bodyOf, nullableString, optionalBoolean, optionalDate, optionalEnum, optionalString, queryString, required } from '../utils/validate';

const queryDate = (value: unknown, field: string) => optionalDate(queryString(value, field), field);
const nullableShift = (value: unknown) => (value === null || value === '' ? null : optionalEnum(value, 'shift', Object.values(Shift)));
const nullableNotes = (value: unknown) => {
  const notes = nullableString(value, 'notes');
  if (notes && notes.length > 500) throw Errors.INVALID_FIELD('notes', 'must be at most 500 characters');
  return notes;
};

// GET /api/v1/school-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — any signed-in user
// Each date with whether the morning and afternoon shifts are taught, and the entries on it
export async function calendar(req: Request, res: Response) {
  const from = required(queryDate(req.query.from, 'from'), 'from');
  const to = required(queryDate(req.query.to, 'to'), 'to');
  res.json({ status: 'success', data: await calendarService.getCalendar(from, to) });
}

// GET /api/v1/school-calendar/week — any signed-in user
export async function week(_req: Request, res: Response) {
  res.json({ status: 'success', data: await calendarService.getSchoolWeek() });
}

// PUT /api/v1/school-calendar/week — MANAGE_SCHOOL_CALENDAR
// { weekdays: [{ dayOfWeek: 1–7, morning: boolean, afternoon: boolean }] } — all seven days
export async function updateWeek(req: Request, res: Response) {
  const { weekdays } = bodyOf(req);
  if (!Array.isArray(weekdays)) throw Errors.SCHOOL_WEEK_INVALID();
  const parsed = weekdays.map((day: unknown) => {
    const d = (day ?? {}) as Record<string, unknown>;
    if (typeof d.dayOfWeek !== 'number' || typeof d.morning !== 'boolean' || typeof d.afternoon !== 'boolean') {
      throw Errors.SCHOOL_WEEK_INVALID();
    }
    return { dayOfWeek: d.dayOfWeek, morning: d.morning, afternoon: d.afternoon };
  });
  res.json({ status: 'success', data: await calendarService.updateSchoolWeek(parsed) });
}

// GET /api/v1/school-calendar/events?from=&to=&type= — any signed-in user
// Entries overlapping the range, plus every holiday that repeats yearly
export async function listEvents(req: Request, res: Response) {
  const data = await calendarService.listEvents({
    from: queryDate(req.query.from, 'from'),
    to: queryDate(req.query.to, 'to'),
    type: optionalEnum(queryString(req.query.type, 'type'), 'type', Object.values(CalendarEventType)),
  });
  res.json({ status: 'success', data });
}

function eventInput(body: Record<string, unknown>) {
  return {
    type: optionalEnum(body.type, 'type', Object.values(CalendarEventType)),
    khmerName: optionalString(body.khmerName, 'khmerName', 100),
    latinName: nullableString(body.latinName, 'latinName'),
    startDate: optionalDate(body.startDate, 'startDate'),
    endDate: optionalDate(body.endDate, 'endDate'),
    shift: nullableShift(body.shift),
    closesSchool: optionalBoolean(body.closesSchool, 'closesSchool'),
    recursYearly: optionalBoolean(body.recursYearly, 'recursYearly'),
    notes: nullableNotes(body.notes),
  };
}

// POST /api/v1/school-calendar/events — MANAGE_SCHOOL_CALENDAR
// { type, khmerName, latinName?, startDate, endDate, shift?, closesSchool?, recursYearly?, notes? }
export async function createEvent(req: Request, res: Response) {
  const input = eventInput(bodyOf(req));
  const event = await calendarService.createEvent({
    ...input,
    type: required(input.type, 'type'),
    khmerName: required(input.khmerName, 'khmerName'),
    startDate: required(input.startDate, 'startDate'),
    endDate: required(input.endDate, 'endDate'),
  });
  res.status(201).json({ status: 'success', data: event });
}

// PATCH /api/v1/school-calendar/events/:id — MANAGE_SCHOOL_CALENDAR
export async function updateEvent(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await calendarService.updateEvent(req.params.id, eventInput(bodyOf(req))) });
}

// DELETE /api/v1/school-calendar/events/:id — MANAGE_SCHOOL_CALENDAR
export async function deleteEvent(req: Request<{ id: string }>, res: Response) {
  await calendarService.deleteEvent(req.params.id);
  res.status(204).end();
}
