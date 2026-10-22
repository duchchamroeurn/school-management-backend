// Attendance (វត្តមាន): daily gate attendance taken by the homeroom teacher (subjectId = null), or attendance
// for one subject's lesson taken by that subject's teacher. A whole class is marked in one call.
import { Errors } from '../constants/errors';
import { AcademicYearStatus, AttendanceStatus, LeaveRequestStatus, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { isoDate, todayAtSchool } from '../utils/dates';
import { audit } from './audit.service';
import { schoolDayStatus } from './calendar.service';

export interface AttendanceEntryInput {
  studentId: string;
  status: AttendanceStatus;
  remarks?: string | null;
}

export interface MarkClassAttendanceInput {
  classSectionId: string;
  date: Date; // date only (UTC midnight), e.g. from optionalDate()
  subjectId?: string | null; // omitted / null = daily gate attendance
  records: AttendanceEntryInput[];
}

export interface AttendanceActor {
  staffProfileId: string | null; // the signed-in user's staff profile (null for non-staff logins)
  // May mark any class and subject; otherwise only the homeroom teacher (daily) or the subject's teacher
  canMarkAny: boolean;
}

export interface MarkedAttendance {
  attendanceRecordId: string;
  student: { id: string; studentIdentifier: string; khmerName: string; latinName: string };
  status: AttendanceStatus; // the status actually saved
  excusedByLeave: boolean; // true = sent as ABSENT_UNEXCUSED, saved as ABSENT_EXCUSED because of approved leave
  leaveRequestId: string | null;
  remarks: string | null;
  created: boolean;
}


/**
 * Students (among studentIds) who have an APPROVED leave request covering `date` (start and end inclusive).
 * Returns studentId → leaveRequestId.
 */
export async function findApprovedLeave(db: Prisma.TransactionClient, studentIds: string[], date: Date) {
  if (!studentIds.length) return new Map<string, string>();
  const leaves = await db.leaveRequest.findMany({
    where: {
      studentId: { in: studentIds },
      status: LeaveRequestStatus.APPROVED,
      startDate: { lte: date },
      endDate: { gte: date },
    },
    select: { id: true, studentId: true },
  });
  return new Map(leaves.map((l) => [l.studentId, l.id]));
}

/**
 * Marks (or corrects) attendance for students of one class on one date.
 *
 * Before a student is saved as ABSENT_UNEXCUSED, the LeaveRequest table is checked: if the student has an
 * approved leave covering that exact date, the status is silently saved as ABSENT_EXCUSED instead.
 *
 * Runs in one transaction with the class row locked, so two people marking the same class at the same time
 * can't create duplicate records (PostgreSQL's unique index doesn't cover daily records, whose subjectId is null).
 */
export async function markClassAttendance(actor: AttendanceActor, input: MarkClassAttendanceInput) {
  if (!input.records.length) throw Errors.ATTENDANCE_RECORDS_REQUIRED();
  const ids = input.records.map((r) => r.studentId);
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length) throw Errors.DUPLICATE_STUDENTS_IN_REQUEST(duplicated);

  const date = isoDate(input.date);
  if (date > todayAtSchool()) throw Errors.ATTENDANCE_DATE_IN_FUTURE(date);
  const subjectId = input.subjectId ?? null;

  return prisma.$transaction(async (tx) => {
    // ── The class: lock it while marking ─────────────────────────────────
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM class_sections WHERE id = ${input.classSectionId} FOR UPDATE`;
    if (!locked) throw Errors.CLASS_SECTION_NOT_FOUND();
    const classSection = await tx.classSection.findUniqueOrThrow({
      where: { id: input.classSectionId },
      include: { grade: true, academicYear: true },
    });
    const { academicYear, grade } = classSection;
    const className = `${grade.gradeNumber}${classSection.sectionName}`;

    if (academicYear.status === AcademicYearStatus.COMPLETED) throw Errors.ACADEMIC_YEAR_CLOSED(academicYear.name, 'its attendance');
    if (input.date < academicYear.startDate || input.date > academicYear.endDate) {
      throw Errors.ATTENDANCE_DATE_OUTSIDE_YEAR(date, academicYear.name, isoDate(academicYear.startDate), isoDate(academicYear.endDate));
    }
    // No attendance on a holiday, a break, or a day the class's shift has no lessons (school calendar)
    const schoolDay = await schoolDayStatus(tx, input.date, classSection.shift);
    if (!schoolDay.open) throw Errors.SCHOOL_CLOSED(date, schoolDay.reason!);

    // ── Subject attendance: the subject must be taught in this grade ──────
    const subject = subjectId ? await tx.subject.findUnique({ where: { id: subjectId } }) : null;
    if (subjectId && !subject) throw Errors.SUBJECT_NOT_FOUND();
    if (subject) {
      const taught = await tx.gradeSubject.findUnique({ where: { gradeId_subjectId: { gradeId: grade.id, subjectId: subject.id } } });
      if (!taught) throw Errors.SUBJECT_NOT_IN_GRADE(subject.latinName, grade.gradeNumber);
    }

    // ── Who may mark: daily = homeroom teacher, subject = its assigned teacher (unless canMarkAny) ──
    if (!actor.canMarkAny) {
      if (!subject) {
        if (!actor.staffProfileId || classSection.homeroomTeacherId !== actor.staffProfileId) throw Errors.NOT_HOMEROOM_TEACHER(className);
      } else {
        const assignment = await tx.subjectTeacherAssignment.findUnique({
          where: { subjectId_classSectionId_academicYearId: { subjectId: subject.id, classSectionId: classSection.id, academicYearId: academicYear.id } },
          select: { staffProfileId: true },
        });
        if (!actor.staffProfileId || assignment?.staffProfileId !== actor.staffProfileId) {
          throw Errors.NOT_TEACHING_SUBJECT_ATTENDANCE(subject.latinName, className);
        }
      }
    }

    // ── Every student must currently be enrolled (and active) in this class ──
    const enrollments = await tx.yearlyEnrollment.findMany({
      where: { classSectionId: classSection.id, studentId: { in: ids }, student: { status: StudentStatus.ENROLLED } },
      include: { student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true } } },
    });
    const studentById = new Map(enrollments.map((e) => [e.studentId, e.student]));
    const notInClass = ids.filter((id) => !studentById.has(id));
    if (notInClass.length) throw Errors.STUDENTS_NOT_IN_CLASS(className, notInClass);

    // ── Approved leave turns an unexcused absence into an excused one ─────
    const unexcused = input.records.filter((r) => r.status === AttendanceStatus.ABSENT_UNEXCUSED).map((r) => r.studentId);
    const onLeave = await findApprovedLeave(tx, unexcused, input.date);

    // ── Save: update each student's existing record for this date/subject, or create one ──
    const existing = new Map(
      (await tx.attendanceRecord.findMany({ where: { studentId: { in: ids }, date: input.date, subjectId } })).map((r) => [r.studentId, r]),
    );

    const results: MarkedAttendance[] = [];
    for (const entry of input.records) {
      const leaveRequestId = entry.status === AttendanceStatus.ABSENT_UNEXCUSED ? onLeave.get(entry.studentId) : undefined;
      const status = leaveRequestId ? AttendanceStatus.ABSENT_EXCUSED : entry.status;
      // The link lets cancelling that leave revert exactly the absences it excused
      const data = { classSectionId: classSection.id, status, remarks: entry.remarks ?? null, leaveRequestId: leaveRequestId ?? null };
      const previous = existing.get(entry.studentId);
      const saved = previous
        ? await tx.attendanceRecord.update({ where: { id: previous.id }, data })
        : await tx.attendanceRecord.create({ data: { ...data, studentId: entry.studentId, subjectId, date: input.date } });

      results.push({
        attendanceRecordId: saved.id,
        student: studentById.get(entry.studentId)!,
        status,
        excusedByLeave: Boolean(leaveRequestId),
        leaveRequestId: leaveRequestId ?? null,
        remarks: saved.remarks,
        created: !previous,
      });
    }

    // ── Audit: each student's status before → after ──────────────────────
    const label = (studentId: string) => studentById.get(studentId)!.studentIdentifier;
    await audit(tx, {
      entityType: 'Attendance',
      action: 'ATTENDANCE_MARKED',
      entityId: classSection.id,
      entityLabel: `${className} ${academicYear.name} — ${date} — ${subject ? subject.code : 'daily'}`,
      before: existing.size ? Object.fromEntries([...existing.values()].map((r) => [label(r.studentId), r.status])) : null,
      after: Object.fromEntries(results.map((r) => [r.student.studentIdentifier, r.excusedByLeave ? `${r.status} (approved leave)` : r.status])),
    });

    const count = (s: AttendanceStatus) => results.filter((r) => r.status === s).length;
    return {
      classSection: { id: classSection.id, name: className, academicYear: academicYear.name },
      date,
      subject: subject && { id: subject.id, code: subject.code, khmerName: subject.khmerName, latinName: subject.latinName },
      summary: {
        marked: results.length,
        present: count(AttendanceStatus.PRESENT),
        late: count(AttendanceStatus.LATE),
        absentUnexcused: count(AttendanceStatus.ABSENT_UNEXCUSED),
        absentExcused: count(AttendanceStatus.ABSENT_EXCUSED),
        excusedByLeave: results.filter((r) => r.excusedByLeave).length,
      },
      records: results,
    };
  });
}

// ==========================================
// READ
// ==========================================

export interface AttendanceViewer {
  staffProfileId: string | null;
  canViewAny: boolean; // VIEW_ANY_ATTENDANCE; otherwise only classes the user teaches
}

const statusCounts = (statuses: AttendanceStatus[]) => ({
  present: statuses.filter((s) => s === AttendanceStatus.PRESENT).length,
  late: statuses.filter((s) => s === AttendanceStatus.LATE).length,
  absentUnexcused: statuses.filter((s) => s === AttendanceStatus.ABSENT_UNEXCUSED).length,
  absentExcused: statuses.filter((s) => s === AttendanceStatus.ABSENT_EXCUSED).length,
});

/**
 * The attendance sheet of one class for one date (daily, or one subject): every active student, their
 * recorded status (null = not marked yet) and any approved leave covering that date, so a screen can
 * pre-fill excused absences before the teacher saves.
 */
export async function getClassAttendance(viewer: AttendanceViewer, classSectionId: string, date: Date, subjectId: string | null) {
  const classSection = await prisma.classSection.findUnique({
    where: { id: classSectionId },
    include: { grade: true, academicYear: true, subjectTeacherAssignments: { select: { staffProfileId: true } } },
  });
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
  const className = `${classSection.grade.gradeNumber}${classSection.sectionName}`;

  // Own classes = homeroom teacher of the class, or teaching any subject in it
  if (!viewer.canViewAny) {
    const teaches =
      !!viewer.staffProfileId &&
      (classSection.homeroomTeacherId === viewer.staffProfileId ||
        classSection.subjectTeacherAssignments.some((a) => a.staffProfileId === viewer.staffProfileId));
    if (!teaches) throw Errors.NOT_CLASS_TEACHER(className);
  }

  const subject = subjectId ? await prisma.subject.findUnique({ where: { id: subjectId } }) : null;
  if (subjectId && !subject) throw Errors.SUBJECT_NOT_FOUND();

  const enrollments = await prisma.yearlyEnrollment.findMany({
    where: { classSectionId, student: { status: StudentStatus.ENROLLED } },
    include: { student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, gender: true } } },
    orderBy: { student: { khmerName: 'asc' } },
  });
  const studentIds = enrollments.map((e) => e.studentId);
  const [records, leaves, schoolDay] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { studentId: { in: studentIds }, date, subjectId } }),
    prisma.leaveRequest.findMany({
      where: { studentId: { in: studentIds }, status: LeaveRequestStatus.APPROVED, startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true, studentId: true, startDate: true, endDate: true, reason: true },
    }),
    schoolDayStatus(prisma, date, classSection.shift),
  ]);
  const outsideYear = date < classSection.academicYear.startDate || date > classSection.academicYear.endDate;
  const recordOf = new Map(records.map((r) => [r.studentId, r]));
  const leaveOf = new Map(leaves.map((l) => [l.studentId, l]));

  const students = enrollments.map((e, i) => {
    const record = recordOf.get(e.studentId);
    const leave = leaveOf.get(e.studentId);
    return {
      no: i + 1,
      ...e.student,
      status: record?.status ?? null, // null = not marked yet
      remarks: record?.remarks ?? null,
      attendanceRecordId: record?.id ?? null,
      approvedLeave: leave ? { id: leave.id, startDate: isoDate(leave.startDate), endDate: isoDate(leave.endDate), reason: leave.reason } : null,
    };
  });
  const marked = students.filter((s) => s.status !== null);

  return {
    classSection: { id: classSection.id, name: className, academicYear: classSection.academicYear.name, shift: classSection.shift },
    date: isoDate(date),
    subject: subject && { id: subject.id, code: subject.code, khmerName: subject.khmerName, latinName: subject.latinName },
    // When the class's shift has no school that day, attendance can't be saved; closedBy is the holiday,
    // break or event that closed it (null when the school week simply has no lessons then)
    // outsideYear: the date is before the class's academic year starts or after it ends
    schoolDay: {
      open: schoolDay.open && !outsideYear,
      outsideYear,
      closedBy: outsideYear || !schoolDay.closedBy ? null : {
        id: schoolDay.closedBy.id,
        type: schoolDay.closedBy.type,
        khmerName: schoolDay.closedBy.khmerName,
        latinName: schoolDay.closedBy.latinName,
      },
    },
    summary: {
      students: students.length,
      marked: marked.length,
      notMarked: students.length - marked.length,
      onApprovedLeave: leaves.length,
      ...statusCounts(marked.map((s) => s.status!)),
    },
    students,
  };
}

/** One student's attendance between two dates (inclusive), with totals for daily attendance. */
export async function getStudentAttendance(studentId: string, from: Date, to: Date) {
  const student = await prisma.studentProfile.findUnique({
    where: { id: studentId },
    select: { id: true, studentIdentifier: true, khmerName: true, latinName: true },
  });
  if (!student) throw Errors.STUDENT_NOT_FOUND();

  const records = await prisma.attendanceRecord.findMany({
    where: { studentId, date: { gte: from, lte: to } },
    include: {
      classSection: { select: { sectionName: true, grade: { select: { gradeNumber: true } } } },
      subject: { select: { id: true, code: true, latinName: true } },
    },
    orderBy: [{ date: 'asc' }, { subjectId: 'asc' }],
  });

  return {
    student,
    from: isoDate(from),
    to: isoDate(to),
    // Totals count daily (gate) attendance only, so one absent day counts once however many lessons it covers
    dailyTotals: { days: records.filter((r) => !r.subjectId).length, ...statusCounts(records.filter((r) => !r.subjectId).map((r) => r.status)) },
    records: records.map((r) => ({
      id: r.id,
      date: isoDate(r.date),
      classSection: `${r.classSection.grade.gradeNumber}${r.classSection.sectionName}`,
      subject: r.subject, // null = daily attendance
      status: r.status,
      remarks: r.remarks,
      leaveRequestId: r.leaveRequestId,
    })),
  };
}
