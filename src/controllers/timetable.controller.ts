import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { Shift } from '../generated/prisma/client';
import * as roomService from '../services/room.service';
import * as timetableService from '../services/timetable.service';
import { bodyOf, optionalEnum, optionalInt, optionalString, queryString, required } from '../utils/validate';

const SHIFTS = Object.values(Shift);

const time = (value: unknown, field: string) => {
  const v = optionalString(value, field, 5);
  if (v !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw Errors.INVALID_FIELD(field, 'must be a time HH:MM (24-hour), e.g. 07:00');
  return v;
};

function slotFields(body: Record<string, unknown>) {
  return {
    dayOfWeek: optionalInt(body.dayOfWeek, 'dayOfWeek', 1, 7),
    shift: optionalEnum(body.shift, 'shift', SHIFTS),
    period: optionalInt(body.period, 'period', 1, 12),
    startTime: time(body.startTime, 'startTime'),
    endTime: time(body.endTime, 'endTime'),
  };
}

// ── Time slots ────────────────────────────────────────────────────────────

// GET /api/v1/timetable/time-slots?shift=MORNING|AFTERNOON
export async function listTimeSlots(req: Request, res: Response) {
  const shift = optionalEnum(queryString(req.query.shift, 'shift'), 'shift', SHIFTS);
  res.json({ status: 'success', data: await timetableService.listTimeSlots(shift) });
}

// POST /api/v1/timetable/time-slots — { dayOfWeek (1 = Monday), shift, period, startTime, endTime }
export async function createTimeSlot(req: Request, res: Response) {
  const f = slotFields(bodyOf(req));
  const slot = await timetableService.createTimeSlot({
    dayOfWeek: required(f.dayOfWeek, 'dayOfWeek'),
    shift: required(f.shift, 'shift'),
    period: required(f.period, 'period'),
    startTime: required(f.startTime, 'startTime'),
    endTime: required(f.endTime, 'endTime'),
  });
  res.status(201).json({ status: 'success', data: slot });
}

// PATCH /api/v1/timetable/time-slots/:id — bell times any time; day/shift/period only while unused
export async function updateTimeSlot(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await timetableService.updateTimeSlot(req.params.id, slotFields(bodyOf(req))) });
}

// DELETE /api/v1/timetable/time-slots/:id — only while no lesson uses it
export async function deleteTimeSlot(req: Request<{ id: string }>, res: Response) {
  await timetableService.deleteTimeSlot(req.params.id);
  res.status(204).end();
}

// ── Lessons and timetables ────────────────────────────────────────────────

// GET /api/v1/timetable/classes/:classSectionId — the week grid plus each subject against its quota
export async function classTimetable(req: Request<{ classSectionId: string }>, res: Response) {
  res.json({ status: 'success', data: await timetableService.getClassTimetable(req.params.classSectionId) });
}

// PUT /api/v1/timetable/classes/:classSectionId/slots/:timeSlotId — { subjectId } (replaces the lesson there)
export async function setLesson(req: Request<{ classSectionId: string; timeSlotId: string }>, res: Response) {
  const subjectId = required(optionalString(bodyOf(req).subjectId, 'subjectId'), 'subjectId');
  res.json({ status: 'success', data: await timetableService.setLesson(req.params.classSectionId, req.params.timeSlotId, subjectId) });
}

// DELETE /api/v1/timetable/classes/:classSectionId/slots/:timeSlotId — frees the slot
export async function removeLesson(req: Request<{ classSectionId: string; timeSlotId: string }>, res: Response) {
  await timetableService.removeLesson(req.params.classSectionId, req.params.timeSlotId);
  res.status(204).end();
}

// GET /api/v1/timetable/teachers/:staffId?academicYearId=
export async function teacherTimetable(req: Request<{ staffId: string }>, res: Response) {
  res.json({ status: 'success', data: await timetableService.getTeacherTimetable(req.params.staffId, queryString(req.query.academicYearId, 'academicYearId')) });
}

// GET /api/v1/timetable/me — a teacher's lessons, or a student's class timetable
export async function myTimetable(req: Request, res: Response) {
  res.json({ status: 'success', data: await timetableService.getMyTimetable({ id: req.user!.id, staffProfileId: req.user!.staffProfileId }) });
}

// GET /api/v1/timetable/quotas?academicYearId= — every class against the MoEYS weekly quotas
export async function quotaOverview(req: Request, res: Response) {
  res.json({ status: 'success', data: await timetableService.getQuotaOverview(queryString(req.query.academicYearId, 'academicYearId')) });
}

// ── Rooms ─────────────────────────────────────────────────────────────────

const roomCapacity = (value: unknown) => (value === null ? null : optionalInt(value, 'capacity', 1, 500));

// GET /api/v1/rooms — with the classes using each room this year (one per shift)
export async function listRooms(_req: Request, res: Response) {
  res.json({ status: 'success', data: await roomService.listRooms() });
}

// POST /api/v1/rooms — { name, capacity? }
export async function createRoom(req: Request, res: Response) {
  const body = bodyOf(req);
  const room = await roomService.createRoom({ name: required(optionalString(body.name, 'name', 60), 'name'), capacity: roomCapacity(body.capacity) });
  res.status(201).json({ status: 'success', data: room });
}

// PATCH /api/v1/rooms/:id — { name?, capacity? }
export async function updateRoom(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  res.json({ status: 'success', data: await roomService.updateRoom(req.params.id, { name: optionalString(body.name, 'name', 60), capacity: roomCapacity(body.capacity) }) });
}

// DELETE /api/v1/rooms/:id — only a room no class uses
export async function deleteRoom(req: Request<{ id: string }>, res: Response) {
  await roomService.deleteRoom(req.params.id);
  res.status(204).end();
}

