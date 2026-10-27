// Leave requests (ច្បាប់ឈប់សម្រាក): recorded as PENDING, then approved, rejected or cancelled by a reviewer.
// Approving also excuses absences already recorded in its date range (parents often bring the letter after
// the absence). Cancelling an approved leave reverts exactly the absences it excused.
import { Errors } from '../constants/errors';
import { AcademicYearStatus, AttendanceStatus, LeaveRequestStatus, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';
import { schoolDayCounter } from './calendar.service';

export const MAX_LEAVE_DAYS = 90;

export interface CreateLeaveRequestInput {
  studentId: string;
  startDate: Date;
  endDate: Date;
  reason?: string | null;
}

export interface ListLeaveRequestsFilter {
  studentId?: string;
  status?: LeaveRequestStatus;
  from?: Date; // leave that overlaps [from, to]
  to?: Date;
  skip: number;
  take: number;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

const details = {
  student: {
    select: {
      id: true,
      studentIdentifier: true,
      khmerName: true,
      latinName: true,
      // Only to find the class shift for counting school days; not sent to clients
      enrollments: { select: { classSection: { select: { shift: true } }, academicYear: { select: { startDate: true, endDate: true } } } },
    },
  },
  _count: { select: { excusedAttendance: true } },
} satisfies Prisma.LeaveRequestInclude;

type LeaveWithDetails = Prisma.LeaveRequestGetPayload<{ include: typeof details }>;

/**
 * The shift of the student's class in the academic year the leave starts in. null for a full-day class (or no class
 * then): a day counts when either shift is taught.
 */
const shiftOf = (leave: LeaveWithDetails) =>
  leave.student.enrollments.find((e) => e.academicYear.startDate <= leave.startDate && e.academicYear.endDate >= leave.startDate)
    ?.classSection.shift ?? null;

/**
 * Leave requests as sent to clients. `days` counts every calendar day; `schoolDays` only the days the student's
 * class has lessons (school calendar: no weekends off, holidays or breaks).
 */
async function toDtos(db: Prisma.TransactionClient, leaves: LeaveWithDetails[]) {
  if (!leaves.length) return [];
  const from = new Date(Math.min(...leaves.map((l) => l.startDate.getTime())));
  const to = new Date(Math.max(...leaves.map((l) => l.endDate.getTime())));
  const countSchoolDays = await schoolDayCounter(db, from, to);
  return leaves.map((full) => {
    const schoolDays = countSchoolDays(full.startDate, full.endDate, shiftOf(full));
    const { _count, student: { enrollments: _enrollments, ...student }, ...leave } = full;
    return {
      ...leave,
      student,
      startDate: isoDate(leave.startDate),
      endDate: isoDate(leave.endDate),
      days: Math.round((leave.endDate.getTime() - leave.startDate.getTime()) / DAY_MS) + 1,
      schoolDays,
      excusedAbsences: _count.excusedAttendance,
    };
  });
}

const toDto = async (db: Prisma.TransactionClient, leave: LeaveWithDetails) => (await toDtos(db, [leave]))[0]!;

const label = (leave: LeaveWithDetails) =>
  `${leave.student.studentIdentifier} ${leave.student.latinName} — ${isoDate(leave.startDate)} – ${isoDate(leave.endDate)}`;

// Attendance in completed academic years is final and never changed by leave decisions
const openYear: Prisma.AttendanceRecordWhereInput = {
  classSection: { academicYear: { status: { not: AcademicYearStatus.COMPLETED } } },
};

/** Loads the leave request with its row locked for the rest of the transaction (status changes serialise). */
async function lockLeave(tx: Prisma.TransactionClient, id: string) {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM leave_requests WHERE id = ${id} FOR UPDATE`;
  if (!locked) throw Errors.LEAVE_REQUEST_NOT_FOUND();
  return tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: details });
}

export async function listLeaveRequests(filter: ListLeaveRequestsFilter) {
  const where: Prisma.LeaveRequestWhereInput = {
    studentId: filter.studentId,
    status: filter.status,
    ...(filter.from && { endDate: { gte: filter.from } }),
    ...(filter.to && { startDate: { lte: filter.to } }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.leaveRequest.findMany({ where, include: details, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }], skip: filter.skip, take: filter.take }),
    prisma.leaveRequest.count({ where }),
  ]);
  return { items: await toDtos(prisma, items), total };
}

export async function getLeaveRequest(id: string) {
  const leave = await prisma.leaveRequest.findUnique({ where: { id }, include: details });
  if (!leave) throw Errors.LEAVE_REQUEST_NOT_FOUND();
  return toDto(prisma, leave);
}

/** Records a leave request as PENDING. A student can't have two pending/approved requests that overlap. */
export async function createLeaveRequest(input: CreateLeaveRequestInput) {
  if (input.endDate < input.startDate) throw Errors.LEAVE_DATES_INVALID();
  const days = Math.round((input.endDate.getTime() - input.startDate.getTime()) / DAY_MS) + 1;
  if (days > MAX_LEAVE_DAYS) throw Errors.LEAVE_TOO_LONG(MAX_LEAVE_DAYS);

  return prisma.$transaction(async (tx) => {
    // Lock the student so two simultaneous requests can't both pass the overlap check
    const [student] = await tx.$queryRaw<{ id: string; status: StudentStatus; student_identifier: string }[]>`
      SELECT id, status, student_identifier FROM student_profiles WHERE id = ${input.studentId} FOR UPDATE`;
    if (!student) throw Errors.STUDENT_NOT_FOUND();
    if (student.status !== StudentStatus.ENROLLED) throw Errors.STUDENT_NOT_ACTIVE(student.student_identifier, student.status, 'given leave');

    const overlap = await tx.leaveRequest.findFirst({
      where: {
        studentId: input.studentId,
        status: { in: [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED] },
        startDate: { lte: input.endDate },
        endDate: { gte: input.startDate },
      },
    });
    if (overlap) {
      throw Errors.LEAVE_OVERLAP({ id: overlap.id, status: overlap.status, startDate: isoDate(overlap.startDate), endDate: isoDate(overlap.endDate) });
    }

    const leave = await tx.leaveRequest.create({
      data: { studentId: input.studentId, startDate: input.startDate, endDate: input.endDate, reason: input.reason ?? null },
      include: details,
    });
    await audit(tx, {
      entityType: 'LeaveRequest',
      action: 'LEAVE_REQUEST_CREATED',
      entityId: leave.id,
      entityLabel: label(leave),
      after: { status: leave.status, startDate: isoDate(leave.startDate), endDate: isoDate(leave.endDate), reason: leave.reason },
    });
    return toDto(tx, leave);
  });
}

/** PENDING → APPROVED, and excuse absences already recorded in the range (in open academic years). */
export async function approveLeaveRequest(id: string) {
  return prisma.$transaction(async (tx) => {
    const leave = await lockLeave(tx, id);
    if (leave.status !== LeaveRequestStatus.PENDING) throw Errors.LEAVE_STATUS_INVALID(leave.status, 'approved');

    await tx.leaveRequest.update({ where: { id }, data: { status: LeaveRequestStatus.APPROVED } });
    const excused = await tx.attendanceRecord.updateMany({
      where: {
        ...openYear,
        studentId: leave.studentId,
        date: { gte: leave.startDate, lte: leave.endDate },
        status: AttendanceStatus.ABSENT_UNEXCUSED,
      },
      data: { status: AttendanceStatus.ABSENT_EXCUSED, leaveRequestId: id },
    });

    await audit(tx, {
      entityType: 'LeaveRequest',
      action: 'LEAVE_REQUEST_APPROVED',
      entityId: id,
      entityLabel: label(leave),
      before: { status: leave.status },
      after: { status: LeaveRequestStatus.APPROVED, excusedAbsences: excused.count },
    });
    return { leaveRequest: await toDto(tx, await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: details })), excusedAbsences: excused.count };
  });
}

/** PENDING → REJECTED. */
export async function rejectLeaveRequest(id: string) {
  return prisma.$transaction(async (tx) => {
    const leave = await lockLeave(tx, id);
    if (leave.status !== LeaveRequestStatus.PENDING) throw Errors.LEAVE_STATUS_INVALID(leave.status, 'rejected');
    await tx.leaveRequest.update({ where: { id }, data: { status: LeaveRequestStatus.REJECTED } });
    await audit(tx, {
      entityType: 'LeaveRequest',
      action: 'LEAVE_REQUEST_REJECTED',
      entityId: id,
      entityLabel: label(leave),
      before: { status: leave.status },
      after: { status: LeaveRequestStatus.REJECTED },
    });
    return { leaveRequest: await toDto(tx, await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: details })) };
  });
}

/**
 * PENDING or APPROVED → CANCELLED. For an approved leave, the absences it excused (in open academic years)
 * become unexcused again — unless another approved leave of the student still covers that date, in which
 * case the record is re-linked to that leave and stays excused.
 */
export async function cancelLeaveRequest(id: string) {
  return prisma.$transaction(async (tx) => {
    const leave = await lockLeave(tx, id);
    if (leave.status !== LeaveRequestStatus.PENDING && leave.status !== LeaveRequestStatus.APPROVED) {
      throw Errors.LEAVE_STATUS_INVALID(leave.status, 'cancelled');
    }
    await tx.leaveRequest.update({ where: { id }, data: { status: LeaveRequestStatus.CANCELLED } });

    let reverted = 0;
    let stillExcused = 0;
    if (leave.status === LeaveRequestStatus.APPROVED) {
      const excusedRecords = await tx.attendanceRecord.findMany({
        where: { ...openYear, leaveRequestId: id, status: AttendanceStatus.ABSENT_EXCUSED },
        select: { id: true, date: true },
      });
      const otherLeaves = await tx.leaveRequest.findMany({
        where: { studentId: leave.studentId, status: LeaveRequestStatus.APPROVED, id: { not: id } },
        select: { id: true, startDate: true, endDate: true },
      });
      for (const record of excusedRecords) {
        const other = otherLeaves.find((l) => l.startDate <= record.date && l.endDate >= record.date);
        if (other) {
          await tx.attendanceRecord.update({ where: { id: record.id }, data: { leaveRequestId: other.id } });
          stillExcused++;
        } else {
          await tx.attendanceRecord.update({
            where: { id: record.id },
            data: { status: AttendanceStatus.ABSENT_UNEXCUSED, leaveRequestId: null },
          });
          reverted++;
        }
      }
    }

    await audit(tx, {
      entityType: 'LeaveRequest',
      action: 'LEAVE_REQUEST_CANCELLED',
      entityId: id,
      entityLabel: label(leave),
      before: { status: leave.status },
      after: { status: LeaveRequestStatus.CANCELLED, ...(leave.status === LeaveRequestStatus.APPROVED && { revertedAbsences: reverted, stillExcusedByOtherLeave: stillExcused }) },
    });
    return {
      leaveRequest: await toDto(tx, await tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: details })),
      revertedAbsences: reverted,
      stillExcusedByOtherLeave: stillExcused,
    };
  });
}
