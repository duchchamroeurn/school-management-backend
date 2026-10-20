import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { PERMISSIONS } from '../constants/permissions';
import { AttendanceStatus } from '../generated/prisma/client';
import * as attendanceService from '../services/attendance.service';
import { MAX_CAPACITY_LIMIT } from '../services/class-section.service';
import { bodyOf, nullableString, optionalDate, optionalEnum, optionalString, queryString, required } from '../utils/validate';

const STATUSES = Object.values(AttendanceStatus);
const MAX_HISTORY_DAYS = 366;

// records: [{ studentId, status, remarks? }] — at most one class worth of students
function parseRecords(value: unknown): attendanceService.AttendanceEntryInput[] {
  if (!Array.isArray(value) || value.length > MAX_CAPACITY_LIMIT) {
    throw Errors.INVALID_FIELD('records', `must be an array of at most ${MAX_CAPACITY_LIMIT} { studentId, status, remarks? } objects`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw Errors.INVALID_FIELD(`records[${i}]`, 'must be an object { studentId, status, remarks? }');
    const entry = item as Record<string, unknown>;
    return {
      studentId: required(optionalString(entry.studentId, `records[${i}].studentId`), `records[${i}].studentId`),
      status: required(optionalEnum(entry.status, `records[${i}].status`, STATUSES), `records[${i}].status`),
      remarks: nullableString(entry.remarks, `records[${i}].remarks`),
    };
  });
}

const queryDate = (value: unknown, field: string) => optionalDate(queryString(value, field), field);

// POST /api/v1/attendance
// Body: { classSectionId, date: "YYYY-MM-DD", subjectId?: null | id, records: [{ studentId, status, remarks? }] }
// subjectId omitted/null = daily attendance (homeroom teacher); otherwise that subject's teacher.
// ABSENT_UNEXCUSED is saved as ABSENT_EXCUSED when the student has approved leave that day (excusedByLeave: true).
// Sending again corrects the records.
export async function mark(req: Request, res: Response) {
  const body = bodyOf(req);
  const actor = { staffProfileId: req.user!.staffProfileId, canMarkAny: req.user!.permissions.includes(PERMISSIONS.ATTENDANCE.MARK_ANY) };
  const result = await attendanceService.markClassAttendance(actor, {
    classSectionId: required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
    date: required(optionalDate(body.date, 'date'), 'date'),
    subjectId: nullableString(body.subjectId, 'subjectId'),
    records: parseRecords(required(body.records, 'records')),
  });
  res.json({ status: 'success', data: result });
}

// GET /api/v1/attendance/class-sections/:id?date=YYYY-MM-DD&subjectId=
// The class sheet for a date: every student with their status (null = not marked yet) and any approved leave.
export async function classSheet(req: Request<{ id: string }>, res: Response) {
  const viewer = { staffProfileId: req.user!.staffProfileId, canViewAny: req.user!.permissions.includes(PERMISSIONS.ATTENDANCE.VIEW_ANY) };
  const sheet = await attendanceService.getClassAttendance(
    viewer,
    req.params.id,
    required(queryDate(req.query.date, 'date'), 'date'),
    queryString(req.query.subjectId, 'subjectId') ?? null,
  );
  res.json({ status: 'success', data: sheet });
}

// GET /api/v1/attendance/students/:id?from=YYYY-MM-DD&to=YYYY-MM-DD (at most one year)
export async function studentHistory(req: Request<{ id: string }>, res: Response) {
  const from = required(queryDate(req.query.from, 'from'), 'from');
  const to = required(queryDate(req.query.to, 'to'), 'to');
  if (to < from) throw Errors.INVALID_FIELD('to', 'must be on or after from');
  if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_HISTORY_DAYS) throw Errors.INVALID_FIELD('to', `must be at most ${MAX_HISTORY_DAYS} days after from`);
  res.json({ status: 'success', data: await attendanceService.getStudentAttendance(req.params.id, from, to) });
}
