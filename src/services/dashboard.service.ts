// Dashboard summary for the signed-in user. Each section is included only when the user holds the permission
// behind it, so a custom role gets exactly the sections its permissions allow. School-wide sections need
// school-wide permissions; the "my…" sections cover only the user's own classes or record.
//
// Everything is for the ACTIVE academic year (or the one asked for). Sections return numbers and ids, never
// labels: the frontend renders them in Khmer or English.
import { PERMISSIONS } from '../constants/permissions';
import { AcademicYearStatus, AttendanceStatus, Gender, LeaveRequestStatus, Shift, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { todayAtSchool } from '../utils/dates';
import { classDayStatus, schoolDayStatus } from './calendar.service';
import { halfDayShift } from '../constants/class-schedule';

export interface DashboardViewer {
  userId: string;
  permissions: string[];
  staffProfileId: string | null;
}

type Count = { total: number; female: number };
const count = (): Count => ({ total: 0, female: 0 });
const add = (c: Count, gender: Gender) => {
  c.total++;
  if (gender === Gender.F) c.female++;
};
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const className = (c: { sectionName: string; grade: { gradeNumber: number } }) => `${c.grade.gradeNumber}${c.sectionName}`;
const dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const daysBefore = (iso: string, days: number) => new Date(dateOnly(iso).getTime() - days * 86_400_000);

type ClosedBy = Awaited<ReturnType<typeof schoolDayStatus>>['closedBy'];
const closedByDto = (event: ClosedBy) => event && { id: event.id, type: event.type, khmerName: event.khmerName, latinName: event.latinName };

type YearDates = { id: string; startDate: Date; endDate: Date };
/** Before the year starts or after it ends there is no school, whatever the calendar says for that weekday. */
const outsideYear = (year: YearDates, iso: string) => dateOnly(iso) < year.startDate || dateOnly(iso) > year.endDate;

// Students frequently absent: this many unexcused daily absences in the last 30 days
const FREQUENT_ABSENCE_THRESHOLD = 3;

// Logins from addresses outside the school network are worth a look (they may be legitimate, e.g. a VPN)
const isPrivateIp = (ip: string | null) => {
  if (!ip) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  return (
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(v4) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
    ip === '::1' ||
    /^f[cd]/i.test(ip) ||
    /^fe80:/i.test(ip)
  );
};

// ── School-wide sections ──────────────────────────────────────────────────

async function enrollmentSection(yearId: string) {
  const enrollments = await prisma.yearlyEnrollment.findMany({
    where: { academicYearId: yearId },
    select: { enrollmentType: true, classSection: { select: { grade: { select: { gradeNumber: true } } } }, student: { select: { gender: true, status: true } } },
  });
  const totals = { active: count(), newAdmissions: count(), promoted: count(), repeating: count(), droppedOut: count(), graduated: count() };
  const byGrade = new Map<number, Count>();
  for (const e of enrollments) {
    const { gender, status } = e.student;
    if (status === StudentStatus.ENROLLED) {
      add(totals.active, gender);
      const grade = e.classSection.grade.gradeNumber;
      add(byGrade.get(grade) ?? byGrade.set(grade, count()).get(grade)!, gender);
    }
    if (status === StudentStatus.DROPPED_OUT) add(totals.droppedOut, gender);
    if (status === StudentStatus.GRADUATED) add(totals.graduated, gender);
    add(totals[e.enrollmentType === 'NEW_ADMISSION' ? 'newAdmissions' : e.enrollmentType === 'PROMOTED' ? 'promoted' : 'repeating'], gender);
  }
  // Studying at the school but not placed in a class this year
  const notEnrolledThisYear = await prisma.studentProfile.count({
    where: { status: StudentStatus.ENROLLED, enrollments: { none: { academicYearId: yearId } } },
  });
  return {
    ...totals,
    byGrade: [...byGrade].sort(([a], [b]) => a - b).map(([gradeNumber, active]) => ({ gradeNumber, active })),
    notEnrolledThisYear,
  };
}

async function capacitySection(yearId: string) {
  const classes = await prisma.classSection.findMany({
    where: { academicYearId: yearId },
    include: { grade: true, _count: { select: { enrollments: { where: { student: { status: StudentStatus.ENROLLED } } } } } },
    orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
  const rows = classes.map((c) => ({
    classSectionId: c.id,
    name: className(c),
    enrolled: c._count.enrollments,
    maxCapacity: c.maxCapacity,
    seatsLeft: Math.max(c.maxCapacity - c._count.enrollments, 0),
  }));
  return {
    classes: rows.length,
    fullClasses: rows.filter((r) => r.seatsLeft === 0).length,
    seatsLeft: rows.reduce((s, r) => s + r.seatsLeft, 0),
    byClass: rows,
  };
}

/**
 * Daily (gate) attendance today across the school; the denominator is the students actually marked. Only classes
 * whose shift has school today count (school calendar): on a holiday, or a Saturday afternoon, none are expected.
 */
async function attendanceTodaySection(year: YearDates) {
  const yearId = year.id;
  const today = todayAtSchool();
  const [morning, afternoon, allClasses] = await Promise.all([
    schoolDayStatus(prisma, dateOnly(today), Shift.MORNING),
    schoolDayStatus(prisma, dateOnly(today), Shift.AFTERNOON),
    prisma.classSection.findMany({ where: { academicYearId: yearId }, include: { grade: true } }),
  ]);
  const outside = outsideYear(year, today);
  const open = { [Shift.MORNING]: !outside && morning.open, [Shift.AFTERNOON]: !outside && afternoon.open };
  // A full-day class has school when either shift does (e.g. Saturday morning)
  const classes = allClasses.filter((c) => {
    const shift = halfDayShift(c.schedule);
    return shift ? open[shift] : open[Shift.MORNING] || open[Shift.AFTERNOON];
  });
  const groups = await prisma.attendanceRecord.groupBy({
    by: ['classSectionId', 'status'],
    where: { date: dateOnly(today), subjectId: null, classSectionId: { in: classes.map((c) => c.id) } },
    _count: true,
  });
  const byStatus = Object.fromEntries(Object.values(AttendanceStatus).map((s) => [s, 0])) as Record<AttendanceStatus, number>;
  for (const g of groups) byStatus[g.status] += g._count;
  const marked = new Set(groups.map((g) => g.classSectionId));
  const studentsMarked = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    date: today,
    // closedBy: the holiday, break or event that closed the school today (null on a day the school week has off)
    // outsideYear: today is before the year starts or after it ends, so no class takes attendance
    schoolDay: {
      morning: open[Shift.MORNING],
      afternoon: open[Shift.AFTERNOON],
      outsideYear: outside,
      closedBy: outside ? null : closedByDto(morning.closedBy ?? afternoon.closedBy),
    },
    classes: classes.length,
    classesMarked: marked.size,
    classesNotMarked: classes.filter((c) => !marked.has(c.id)).map((c) => ({ classSectionId: c.id, name: className(c) })),
    studentsMarked,
    ...byStatus,
    attendanceRate: pct(byStatus.PRESENT + byStatus.LATE, studentsMarked),
  };
}

/** For each open period: scores entered vs expected (active students × subjects scored in their grade) */
async function scoreEntrySection(yearId: string) {
  const [periods, classes] = await Promise.all([
    prisma.assessmentPeriod.findMany({ where: { academicYearId: yearId, isLocked: false }, include: { subjectConfigs: { select: { id: true, subjectId: true } } }, orderBy: { startDate: 'asc' } }),
    prisma.classSection.findMany({
      where: { academicYearId: yearId },
      include: { grade: { include: { gradeSubjects: { select: { subjectId: true } } } }, _count: { select: { enrollments: { where: { student: { status: StudentStatus.ENROLLED } } } } } },
    }),
  ]);
  return Promise.all(
    periods.map(async (p) => {
      const scored = new Set(p.subjectConfigs.map((c) => c.subjectId));
      const expected = classes.reduce((sum, c) => sum + c._count.enrollments * c.grade.gradeSubjects.filter((gs) => scored.has(gs.subjectId)).length, 0);
      const [entered, resultClasses] = await Promise.all([
        prisma.monthlySubjectScore.count({
          where: { subjectAssessmentConfig: { assessmentPeriodId: p.id }, enrollment: { academicYearId: yearId, student: { status: StudentStatus.ENROLLED } } },
        }),
        prisma.monthlyResult.findMany({ where: { assessmentPeriodId: p.id }, select: { enrollment: { select: { classSectionId: true } } }, distinct: ['enrollmentId'] }),
      ]);
      return {
        assessmentPeriodId: p.id,
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        scoreEntryDeadline: p.scoreEntryDeadline,
        subjectsScored: p.subjectConfigs.length,
        scoresEntered: entered,
        scoresExpected: expected,
        percentComplete: pct(entered, expected),
        classesWithResults: new Set(resultClasses.map((r) => r.enrollment.classSectionId)).size,
        classes: classes.length,
      };
    }),
  );
}

async function staffingSection(yearId: string) {
  const classes = await prisma.classSection.findMany({
    where: { academicYearId: yearId },
    include: { grade: { include: { gradeSubjects: { select: { subject: { select: { id: true, code: true } } } } } }, subjectTeacherAssignments: { select: { subjectId: true } } },
    orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
  const vacancies = classes
    .map((c) => {
      const assigned = new Set(c.subjectTeacherAssignments.map((a) => a.subjectId));
      return { classSectionId: c.id, name: className(c), vacantSubjects: c.grade.gradeSubjects.filter((gs) => !assigned.has(gs.subject.id)).map((gs) => gs.subject.code) };
    })
    .filter((c) => c.vacantSubjects.length);
  return {
    classesWithoutHomeroomTeacher: classes.filter((c) => !c.homeroomTeacherId).map((c) => ({ classSectionId: c.id, name: className(c) })),
    vacantSubjectSlots: vacancies.reduce((s, c) => s + c.vacantSubjects.length, 0),
    vacancies,
  };
}

async function pendingLeaveSection() {
  const [pending, oldest] = await Promise.all([
    prisma.leaveRequest.count({ where: { status: LeaveRequestStatus.PENDING } }),
    prisma.leaveRequest.findFirst({ where: { status: LeaveRequestStatus.PENDING }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } }),
  ]);
  return { pending, oldestRequestedAt: oldest?.createdAt ?? null };
}

/** Active students whose families can't be reached */
async function dataQualitySection(yearId: string) {
  const active = { status: StudentStatus.ENROLLED, enrollments: { some: { academicYearId: yearId } } };
  const [withoutGuardian, withoutGuardianPhone] = await Promise.all([
    prisma.studentProfile.count({ where: { ...active, guardians: { none: {} } } }),
    prisma.studentProfile.count({ where: { ...active, guardians: { none: { guardian: { phone: { not: null } } } } } }),
  ]);
  return { studentsWithoutGuardian: withoutGuardian, studentsWithoutGuardianPhone: withoutGuardianPhone };
}

async function securitySection(includeUsers: boolean) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [failedLogins, accountLocks, successes] = await Promise.all([
    prisma.auditLog.count({ where: { action: 'LOGIN_FAILED', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { action: 'ACCOUNT_LOCKED', createdAt: { gte: since } } }),
    prisma.auditLog.findMany({
      where: { action: 'LOGIN_SUCCEEDED', createdAt: { gte: since } },
      select: { actorUsername: true, ipAddress: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const externalLogins = successes.filter((s) => !isPrivateIp(s.ipAddress)).map((s) => ({ username: s.actorUsername, ipAddress: s.ipAddress, at: s.createdAt }));
  const section = { last24h: { failedLogins, accountLocks, externalLogins } };
  if (!includeUsers) return section;
  const [byStatus, mustChangePassword] = await Promise.all([
    prisma.user.groupBy({ by: ['status'], _count: true }),
    prisma.user.count({ where: { mustChangePassword: true } }),
  ]);
  return {
    ...section,
    users: { ...Object.fromEntries(byStatus.map((s) => [s.status.toLowerCase(), s._count])), mustChangePassword },
  };
}

// ── The user's own sections ───────────────────────────────────────────────

/** The teacher's assignments × open periods: how many of their students they have scored */
async function myScoreEntrySection(staffProfileId: string, yearId: string) {
  const assignments = await prisma.subjectTeacherAssignment.findMany({
    where: { staffProfileId, academicYearId: yearId },
    include: {
      subject: { select: { id: true, code: true } },
      classSection: { include: { grade: true, enrollments: { where: { student: { status: StudentStatus.ENROLLED } }, select: { id: true } } } },
    },
  });
  if (!assignments.length) return null;
  const periods = await prisma.assessmentPeriod.findMany({
    where: { academicYearId: yearId, isLocked: false },
    include: { subjectConfigs: { where: { subjectId: { in: assignments.map((a) => a.subjectId) } }, select: { id: true, subjectId: true } } },
    orderBy: { startDate: 'asc' },
  });
  const today = todayAtSchool();
  const rows = [];
  for (const p of periods) {
    for (const a of assignments) {
      const config = p.subjectConfigs.find((c) => c.subjectId === a.subjectId);
      if (!config) continue;
      const enrollmentIds = a.classSection.enrollments.map((e) => e.id);
      const entered = await prisma.monthlySubjectScore.count({ where: { subjectAssessmentConfigId: config.id, enrollmentId: { in: enrollmentIds } } });
      rows.push({
        assessmentPeriodId: p.id,
        period: p.name,
        scoreEntryDeadline: p.scoreEntryDeadline,
        deadlinePassed: !!p.scoreEntryDeadline && today > p.scoreEntryDeadline.toISOString().slice(0, 10),
        classSectionId: a.classSectionId,
        className: className(a.classSection),
        subject: a.subject.code,
        entered,
        students: enrollmentIds.length,
        remaining: Math.max(enrollmentIds.length - entered, 0),
      });
    }
  }
  return { remainingTotal: rows.reduce((s, r) => s + r.remaining, 0), items: rows };
}

async function myHomeroomSection(staffProfileId: string, year: YearDates) {
  const yearId = year.id;
  const classSection = await prisma.classSection.findFirst({
    where: { homeroomTeacherId: staffProfileId, academicYearId: yearId },
    include: { grade: true, enrollments: { where: { student: { status: StudentStatus.ENROLLED } }, select: { studentId: true, student: { select: { gender: true, studentIdentifier: true, khmerName: true, latinName: true } } } } },
  });
  if (!classSection) return null;
  const today = todayAtSchool();
  const studentIds = classSection.enrollments.map((e) => e.studentId);

  const [todayGroups, absences, pendingLeave, periods, schoolDay] = await Promise.all([
    prisma.attendanceRecord.groupBy({ by: ['status'], where: { classSectionId: classSection.id, subjectId: null, date: dateOnly(today) }, _count: true }),
    prisma.attendanceRecord.groupBy({
      by: ['studentId'],
      where: { classSectionId: classSection.id, subjectId: null, status: AttendanceStatus.ABSENT_UNEXCUSED, date: { gte: daysBefore(today, 30) } },
      _count: true,
    }),
    prisma.leaveRequest.count({ where: { status: LeaveRequestStatus.PENDING, studentId: { in: studentIds } } }),
    prisma.assessmentPeriod.findMany({
      where: { academicYearId: yearId },
      select: { id: true, name: true, isLocked: true, _count: { select: { results: { where: { enrollment: { classSectionId: classSection.id } } } } } },
      orderBy: { startDate: 'asc' },
    }),
    classDayStatus(prisma, dateOnly(today), halfDayShift(classSection.schedule)),
  ]);

  const students = count();
  for (const e of classSection.enrollments) add(students, e.student.gender);
  const byId = new Map(classSection.enrollments.map((e) => [e.studentId, e.student]));
  const attendanceToday = Object.fromEntries(todayGroups.map((g) => [g.status, g._count]));
  return {
    classSectionId: classSection.id,
    name: className(classSection),
    students,
    attendanceToday: {
      date: today,
      marked: todayGroups.length > 0,
      // No school for the class today: nothing to mark
      schoolDay: outsideYear(year, today)
        ? { open: false, outsideYear: true, closedBy: null }
        : { open: schoolDay.open, outsideYear: false, closedBy: closedByDto(schoolDay.closedBy) },
      ...attendanceToday,
    },
    frequentAbsentees: absences
      .filter((a) => a._count >= FREQUENT_ABSENCE_THRESHOLD && byId.has(a.studentId))
      .map((a) => ({ studentId: a.studentId, ...byId.get(a.studentId)!, unexcusedAbsences30d: a._count }))
      .sort((a, b) => b.unexcusedAbsences30d - a.unexcusedAbsences30d)
      .map(({ gender: _gender, ...rest }) => rest),
    pendingLeaveRequests: pendingLeave,
    results: periods.map((p) => ({ assessmentPeriodId: p.id, period: p.name, isLocked: p.isLocked, calculated: p._count.results > 0 })),
  };
}

async function myStudentSection(userId: string, yearId: string) {
  const student = await prisma.studentProfile.findUnique({ where: { userId } });
  if (!student) return null;
  const enrollment = await prisma.yearlyEnrollment.findUnique({
    where: { studentId_academicYearId: { studentId: student.id, academicYearId: yearId } },
    include: { classSection: { include: { grade: true, homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } } } } },
  });
  const today = todayAtSchool();
  const monthStart = dateOnly(`${today.slice(0, 8)}01`);
  const [latest, attendance, leave] = await Promise.all([
    enrollment &&
      prisma.monthlyResult.findFirst({
        where: { enrollmentId: enrollment.id },
        include: { assessmentPeriod: { select: { id: true, name: true } } },
        orderBy: { assessmentPeriod: { startDate: 'desc' } },
      }),
    prisma.attendanceRecord.groupBy({ by: ['status'], where: { studentId: student.id, subjectId: null, date: { gte: monthStart } }, _count: true }),
    prisma.leaveRequest.groupBy({ by: ['status'], where: { studentId: student.id, endDate: { gte: daysBefore(today, 30) } }, _count: true }),
  ]);
  return {
    classSection: enrollment && { id: enrollment.classSectionId, name: className(enrollment.classSection), homeroomTeacher: enrollment.classSection.homeroomTeacher },
    latestResult: latest && {
      assessmentPeriodId: latest.assessmentPeriod.id,
      period: latest.assessmentPeriod.name,
      totalScore: latest.totalScore,
      average: latest.average,
      mention: latest.mention,
      classRank: latest.classRank,
    },
    attendanceThisMonth: Object.fromEntries(Object.values(AttendanceStatus).map((s) => [s, attendance.find((a) => a.status === s)?._count ?? 0])),
    leaveRequestsLast30d: Object.fromEntries(leave.map((l) => [l.status, l._count])),
  };
}

// ── Assembly ──────────────────────────────────────────────────────────────

export async function getDashboard(viewer: DashboardViewer, academicYearId?: string) {
  const year = academicYearId
    ? await prisma.academicYear.findUnique({ where: { id: academicYearId } })
    : await prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } });
  const has = (code: string) => viewer.permissions.includes(code);
  const P = PERMISSIONS;

  // Each entry: include the section when the condition holds; null results are left out
  const plan: [string, boolean, () => Promise<unknown>][] = year
    ? [
        ['enrollment', has(P.ENROLLMENT.CREATE), () => enrollmentSection(year.id)],
        ['capacity', has(P.ENROLLMENT.CREATE), () => capacitySection(year.id)],
        ['attendanceToday', has(P.ATTENDANCE.VIEW_ANY), () => attendanceTodaySection(year)],
        ['scoreEntry', has(P.ASSESSMENT.MANAGE) || has(P.SCORE.ENTER_ANY), () => scoreEntrySection(year.id)],
        ['staffing', has(P.CLASS_SECTION.UPDATE) || has(P.STAFF.UPDATE), () => staffingSection(year.id)],
        ['dataQuality', has(P.STUDENT.UPDATE), () => dataQualitySection(year.id)],
        ['myScoreEntry', has(P.SCORE.ENTER) && !!viewer.staffProfileId, () => myScoreEntrySection(viewer.staffProfileId!, year.id)],
        ['myHomeroom', has(P.SELF_SERVICE.VIEW_OWN_HOMEROOM) && !!viewer.staffProfileId, () => myHomeroomSection(viewer.staffProfileId!, year)],
        ['myStudent', has(P.SELF_SERVICE.VIEW_OWN_PROFILE), () => myStudentSection(viewer.userId, year.id)],
      ]
    : [];
  plan.push(
    ['pendingLeave', has(P.LEAVE_REQUEST.REVIEW), pendingLeaveSection],
    ['security', has(P.AUDIT_LOG.LIST), () => securitySection(has(P.USER.LIST))],
  );

  const included = plan.filter(([, allowed]) => allowed);
  const values = await Promise.all(included.map(([, , load]) => load()));
  const sections = Object.fromEntries(included.map(([name], i) => [name, values[i]]).filter(([, value]) => value !== null));

  return {
    generatedAt: new Date(),
    academicYear: year && { id: year.id, name: year.name, status: year.status },
    sections,
  };
}
