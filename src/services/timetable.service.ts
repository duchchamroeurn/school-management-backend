// Weekly timetables. The school's bell schedule is a set of TimeSlots (day × shift × period); each class has
// lessons (TimetableEntry) only in its own shift's slots. Every lesson is checked when it is placed:
//   - the slot belongs to the class's shift (morning / afternoon)
//   - the subject is taught in the class's grade, and its MoEYS weekly quota isn't exceeded
//   - golden rule 2: one lesson per class per slot   (unique constraint; placing again replaces the lesson)
//   - golden rule 1: a teacher is in one class per slot (unique constraint on the lesson's teacher)
// The lesson's teacher is the subject's assigned teacher in that class; syncLessonTeacher keeps it in step
// when assignments change.
import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma, Shift, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';

export interface TimeSlotInput {
  dayOfWeek: number; // 1 = Monday … 6 = Saturday (7 = Sunday)
  shift: Shift;
  period: number;
  startTime: string; // "HH:MM"
  endTime: string;
}

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const slotLabel = (s: { dayOfWeek: number; shift: Shift; period: number; startTime: string; endTime: string }) =>
  `${DAY_NAMES[s.dayOfWeek]} period ${s.period} (${s.shift.toLowerCase()}, ${s.startTime}–${s.endTime})`;
const className = (c: { sectionName: string; grade: { gradeNumber: number } }) => `${c.grade.gradeNumber}${c.sectionName}`;
const teacherName = (t: { latinName: string; khmerName: string }) => `${t.latinName} (${t.khmerName})`;
const SLOT_ORDER = [{ dayOfWeek: 'asc' }, { shift: 'asc' }, { period: 'asc' }] satisfies Prisma.TimeSlotOrderByWithRelationInput[];

const subjectSelect = { id: true, code: true, khmerName: true, latinName: true } as const;
const personSelect = { id: true, khmerName: true, latinName: true } as const;

function assertYearOpen(year: { name: string; status: AcademicYearStatus }) {
  if (year.status === AcademicYearStatus.COMPLETED) throw Errors.ACADEMIC_YEAR_CLOSED(year.name, 'its classes');
}

// ── Time slots (the bell schedule) ────────────────────────────────────────

export const listTimeSlots = (shift?: Shift) =>
  prisma.timeSlot.findMany({ where: { shift }, include: { _count: { select: { entries: true } } }, orderBy: SLOT_ORDER });

async function assertNoOverlap(db: Prisma.TransactionClient, slot: TimeSlotInput, exceptId?: string) {
  if (slot.endTime <= slot.startTime) throw Errors.TIME_SLOT_INVALID();
  const sameDay = await db.timeSlot.findMany({ where: { dayOfWeek: slot.dayOfWeek, shift: slot.shift, id: exceptId ? { not: exceptId } : undefined } });
  const same = sameDay.find((s) => s.period === slot.period);
  if (same) throw Errors.TIME_SLOT_EXISTS(slotLabel(same));
  const overlap = sameDay.find((s) => slot.startTime < s.endTime && s.startTime < slot.endTime);
  if (overlap) throw Errors.TIME_SLOT_OVERLAP(slotLabel(slot), slotLabel(overlap));
}

export async function createTimeSlot(data: TimeSlotInput) {
  return prisma.$transaction(async (tx) => {
    await assertNoOverlap(tx, data);
    const created = await tx.timeSlot.create({ data });
    await audit(tx, { entityType: 'TimeSlot', action: 'TIME_SLOT_CREATED', entityId: created.id, entityLabel: slotLabel(created), after: { ...data } });
    return created;
  });
}

/** Bell times can always change; day, shift and period only while no lesson uses the slot */
export async function updateTimeSlot(id: string, data: Partial<TimeSlotInput>) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.timeSlot.findUnique({ where: { id }, include: { _count: { select: { entries: true } } } });
    if (!current) throw Errors.TIME_SLOT_NOT_FOUND();
    const merged = { dayOfWeek: data.dayOfWeek ?? current.dayOfWeek, shift: data.shift ?? current.shift, period: data.period ?? current.period, startTime: data.startTime ?? current.startTime, endTime: data.endTime ?? current.endTime };
    const moved = merged.dayOfWeek !== current.dayOfWeek || merged.shift !== current.shift || merged.period !== current.period;
    if (moved && current._count.entries) throw Errors.TIME_SLOT_IN_USE(slotLabel(current), current._count.entries);
    await assertNoOverlap(tx, merged, id);
    const updated = await tx.timeSlot.update({ where: { id }, data: merged });
    const { _count, ...before } = current;
    await audit(tx, { entityType: 'TimeSlot', action: 'TIME_SLOT_UPDATED', entityId: id, entityLabel: slotLabel(updated), before, after: updated });
    return updated;
  });
}

export async function deleteTimeSlot(id: string) {
  await prisma.$transaction(async (tx) => {
    const slot = await tx.timeSlot.findUnique({ where: { id }, include: { _count: { select: { entries: true } } } });
    if (!slot) throw Errors.TIME_SLOT_NOT_FOUND();
    if (slot._count.entries) throw Errors.TIME_SLOT_IN_USE(slotLabel(slot), slot._count.entries);
    await tx.timeSlot.delete({ where: { id } });
    await audit(tx, { entityType: 'TimeSlot', action: 'TIME_SLOT_DELETED', entityId: id, entityLabel: slotLabel(slot), before: { ...slot, _count: undefined } });
  });
}

// ── Placing lessons ───────────────────────────────────────────────────────

async function loadClassForTimetable(db: Prisma.TransactionClient, classSectionId: string) {
  const classSection = await db.classSection.findUnique({
    where: { id: classSectionId },
    include: { grade: { include: { gradeSubjects: { include: { subject: { select: subjectSelect } } } } }, academicYear: true, room: true },
  });
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
  return classSection;
}

/** Puts a subject in a class's time slot (replacing the lesson already there). */
export async function setLesson(classSectionId: string, timeSlotId: string, subjectId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialise changes to this class's timetable, so two placements can't both pass the quota check
      await tx.$queryRaw`SELECT id FROM class_sections WHERE id = ${classSectionId} FOR UPDATE`;
      const classSection = await loadClassForTimetable(tx, classSectionId);
      assertYearOpen(classSection.academicYear);
      const name = className(classSection);
      const slot = await tx.timeSlot.findUnique({ where: { id: timeSlotId } });
      if (!slot) throw Errors.TIME_SLOT_NOT_FOUND();
      // A full-day class may use any slot; a half-day class only its own shift's
      if (classSection.shift && slot.shift !== classSection.shift) throw Errors.WRONG_SHIFT(name, classSection.shift, slotLabel(slot));

      const gradeSubject = classSection.grade.gradeSubjects.find((gs) => gs.subjectId === subjectId);
      if (!gradeSubject) {
        const subject = await tx.subject.findUnique({ where: { id: subjectId } });
        if (!subject) throw Errors.SUBJECT_NOT_FOUND();
        throw Errors.SUBJECT_NOT_IN_GRADE(subject.latinName, classSection.grade.gradeNumber);
      }

      const current = await tx.timetableEntry.findUnique({ where: { classSectionId_timeSlotId: { classSectionId, timeSlotId } }, include: { subject: true } });
      if (current?.subjectId === subjectId) return current;

      if (gradeSubject.weeklyPeriods !== null) {
        const scheduled = await tx.timetableEntry.count({ where: { classSectionId, subjectId } });
        if (scheduled >= gradeSubject.weeklyPeriods) throw Errors.QUOTA_EXCEEDED(gradeSubject.subject.latinName, name, gradeSubject.weeklyPeriods);
      }

      const assignment = await tx.subjectTeacherAssignment.findFirst({ where: { classSectionId, subjectId }, include: { staffProfile: { select: personSelect } } });
      const teacher = assignment?.staffProfile ?? null;
      if (teacher) await assertTeacherFree(tx, teacher, slot, classSection.academicYearId, classSectionId);

      const data = { subjectId, staffProfileId: teacher?.id ?? null };
      const entry = current
        ? await tx.timetableEntry.update({ where: { id: current.id }, data })
        : await tx.timetableEntry.create({ data: { ...data, classSectionId, timeSlotId, academicYearId: classSection.academicYearId } });
      await audit(tx, {
        entityType: 'Timetable',
        action: 'LESSON_SCHEDULED',
        entityId: classSectionId,
        entityLabel: `${name} ${classSection.academicYear.name} — ${slotLabel(slot)}`,
        before: current && { subject: current.subject.code },
        after: { subject: gradeSubject.subject.code, teacher: teacher && teacherName(teacher) },
      });
      return tx.timetableEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { subject: { select: subjectSelect }, staffProfile: { select: personSelect }, timeSlot: true } });
    });
  } catch (err) {
    // Two placements for the same teacher at the same moment: the unique constraint stops the second
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.CONFLICT();
    throw err;
  }
}

async function assertTeacherFree(
  tx: Prisma.TransactionClient,
  teacher: { id: string; khmerName: string; latinName: string },
  slot: { id: string; dayOfWeek: number; shift: Shift; period: number; startTime: string; endTime: string },
  academicYearId: string,
  classSectionId: string,
) {
  const busy = await tx.timetableEntry.findFirst({
    where: { staffProfileId: teacher.id, timeSlotId: slot.id, academicYearId, classSectionId: { not: classSectionId } },
    include: { classSection: { include: { grade: true } } },
  });
  if (busy) throw Errors.TEACHER_CLASH(teacherName(teacher), slotLabel(slot), className(busy.classSection));
}

export async function removeLesson(classSectionId: string, timeSlotId: string) {
  await prisma.$transaction(async (tx) => {
    const entry = await tx.timetableEntry.findUnique({
      where: { classSectionId_timeSlotId: { classSectionId, timeSlotId } },
      include: { subject: true, timeSlot: true, classSection: { include: { grade: true, academicYear: true } } },
    });
    if (!entry) return; // already free
    assertYearOpen(entry.classSection.academicYear);
    await tx.timetableEntry.delete({ where: { id: entry.id } });
    await audit(tx, {
      entityType: 'Timetable',
      action: 'LESSON_REMOVED',
      entityId: classSectionId,
      entityLabel: `${className(entry.classSection)} ${entry.classSection.academicYear.name} — ${slotLabel(entry.timeSlot)}`,
      before: { subject: entry.subject.code },
    });
  });
}

/**
 * Called inside the transaction that creates, reassigns or removes a SubjectTeacherAssignment: the class's
 * lessons of that subject get the new teacher (or none). Refused if the new teacher is already teaching
 * another class at one of those times.
 */
export async function syncLessonTeacher(
  tx: Prisma.TransactionClient,
  classSectionId: string,
  subjectId: string,
  teacher: { id: string; khmerName: string; latinName: string } | null,
) {
  const lessons = await tx.timetableEntry.findMany({ where: { classSectionId, subjectId }, include: { timeSlot: true } });
  if (!lessons.length) return;
  if (teacher) {
    const clashes = await tx.timetableEntry.findMany({
      where: {
        staffProfileId: teacher.id,
        academicYearId: lessons[0].academicYearId,
        timeSlotId: { in: lessons.map((l) => l.timeSlotId) },
        classSectionId: { not: classSectionId },
      },
      include: { timeSlot: true, classSection: { include: { grade: true } } },
    });
    if (clashes.length) {
      throw Errors.TEACHER_CLASHES(teacherName(teacher), clashes.map((c) => ({ slot: slotLabel(c.timeSlot), otherClass: className(c.classSection) })));
    }
  }
  await tx.timetableEntry.updateMany({ where: { classSectionId, subjectId }, data: { staffProfileId: teacher?.id ?? null } });
}

// ── Reading timetables ────────────────────────────────────────────────────

/** A class's week: every slot it studies in (lesson or free), plus how each subject stands against its quota */
export async function getClassTimetable(classSectionId: string) {
  const classSection = await loadClassForTimetable(prisma, classSectionId);
  const [slots, entries, assignments] = await Promise.all([
    // Full day: every slot of the bell schedule; half day: its shift's
    prisma.timeSlot.findMany({ where: classSection.shift ? { shift: classSection.shift } : {}, orderBy: SLOT_ORDER }),
    prisma.timetableEntry.findMany({ where: { classSectionId }, include: { subject: { select: subjectSelect }, staffProfile: { select: personSelect } } }),
    prisma.subjectTeacherAssignment.findMany({ where: { classSectionId }, select: { subjectId: true } }),
  ]);
  const bySlot = new Map(entries.map((e) => [e.timeSlotId, e]));
  const days = [...new Set(slots.map((s) => s.dayOfWeek))].map((dayOfWeek) => ({
    dayOfWeek,
    slots: slots
      .filter((s) => s.dayOfWeek === dayOfWeek)
      .map((s) => {
        const e = bySlot.get(s.id);
        return { timeSlotId: s.id, shift: s.shift, period: s.period, startTime: s.startTime, endTime: s.endTime, lesson: e ? { subject: e.subject, teacher: e.staffProfile } : null };
      }),
  }));

  const hasTeacher = new Set(assignments.map((a) => a.subjectId));
  const quotas = classSection.grade.gradeSubjects
    .map((gs) => {
      const scheduled = entries.filter((e) => e.subjectId === gs.subjectId).length;
      const required = gs.weeklyPeriods;
      const status = required === null ? 'NO_QUOTA' : scheduled === required ? 'MET' : scheduled < required ? 'MISSING' : 'OVER';
      return { subject: gs.subject, weeklyPeriods: required, scheduled, missing: required === null ? null : Math.max(required - scheduled, 0), status, hasTeacher: hasTeacher.has(gs.subjectId) };
    })
    .sort((a, b) => a.subject.code.localeCompare(b.subject.code));

  const required = quotas.reduce((s, q) => s + (q.weeklyPeriods ?? 0), 0);
  return {
    classSection: { id: classSection.id, name: className(classSection), shift: classSection.shift, room: classSection.room && { id: classSection.room.id, name: classSection.room.name }, academicYear: classSection.academicYear.name },
    days,
    quotas,
    summary: {
      slots: slots.length,
      lessons: entries.length,
      freeSlots: slots.length - entries.length,
      quotaPeriods: required,
      // A week can only meet the quotas if the class has enough slots for them
      fitsInShift: required <= slots.length,
      subjectsMissingLessons: quotas.filter((q) => q.status === 'MISSING').length,
      lessonsWithoutTeacher: entries.filter((e) => !e.staffProfileId).length,
      complete: quotas.every((q) => q.status === 'MET' || q.status === 'NO_QUOTA') && quotas.some((q) => q.status === 'MET'),
    },
  };
}

/** A teacher's week across both shifts, in the given or the ACTIVE academic year */
export async function getTeacherTimetable(staffProfileId: string, academicYearId?: string) {
  const [staff, year] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { id: staffProfileId }, select: personSelect }),
    academicYearId ? prisma.academicYear.findUnique({ where: { id: academicYearId } }) : prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } }),
  ]);
  if (!staff) throw Errors.STAFF_NOT_FOUND();
  if (!year) throw academicYearId ? Errors.ACADEMIC_YEAR_NOT_FOUND() : Errors.ACADEMIC_YEAR_REQUIRED();
  const entries = await prisma.timetableEntry.findMany({
    where: { staffProfileId, academicYearId: year.id },
    include: { timeSlot: true, subject: { select: subjectSelect }, classSection: { include: { grade: true, room: true } } },
    orderBy: [{ timeSlot: { dayOfWeek: 'asc' } }, { timeSlot: { shift: 'asc' } }, { timeSlot: { period: 'asc' } }],
  });
  const days = [...new Set(entries.map((e) => e.timeSlot.dayOfWeek))].map((dayOfWeek) => ({
    dayOfWeek,
    lessons: entries
      .filter((e) => e.timeSlot.dayOfWeek === dayOfWeek)
      .map((e) => ({
        timeSlotId: e.timeSlotId,
        shift: e.timeSlot.shift,
        period: e.timeSlot.period,
        startTime: e.timeSlot.startTime,
        endTime: e.timeSlot.endTime,
        classSection: { id: e.classSectionId, name: className(e.classSection), room: e.classSection.room?.name ?? null },
        subject: e.subject,
      })),
  }));
  return { teacher: staff, academicYear: year.name, lessonsPerWeek: entries.length, days };
}

/** The signed-in user's week: a teacher's lessons, or a student's class timetable */
export async function getMyTimetable(user: { id: string; staffProfileId: string | null }) {
  if (user.staffProfileId) return { type: 'TEACHER' as const, ...(await getTeacherTimetable(user.staffProfileId)) };
  const student = await prisma.studentProfile.findUnique({ where: { userId: user.id } });
  const year = await prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } });
  if (!student) throw Errors.OWN_PROFILE_NOT_FOUND();
  if (!year) throw Errors.ACADEMIC_YEAR_REQUIRED();
  const enrollment = await prisma.yearlyEnrollment.findUnique({ where: { studentId_academicYearId: { studentId: student.id, academicYearId: year.id } } });
  if (!enrollment) throw Errors.STUDENT_NOT_ENROLLED_IN_YEAR(student.studentIdentifier, year.name);
  return { type: 'CLASS' as const, ...(await getClassTimetable(enrollment.classSectionId)) };
}

/** Every class of the year against the MoEYS quotas, for the coordinator's overview */
export async function getQuotaOverview(academicYearId?: string) {
  const year = academicYearId
    ? await prisma.academicYear.findUnique({ where: { id: academicYearId } })
    : await prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } });
  if (!year) throw academicYearId ? Errors.ACADEMIC_YEAR_NOT_FOUND() : Errors.ACADEMIC_YEAR_REQUIRED();
  const classes = await prisma.classSection.findMany({
    where: { academicYearId: year.id },
    include: {
      grade: { include: { gradeSubjects: { include: { subject: { select: { code: true } } } } } },
      timetableEntries: { select: { subjectId: true, staffProfileId: true } },
      _count: { select: { enrollments: { where: { student: { status: StudentStatus.ENROLLED } } } } },
    },
    orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
  const slotsPerShift = Object.fromEntries((await prisma.timeSlot.groupBy({ by: ['shift'], _count: true })).map((g) => [g.shift, g._count]));
  const allSlots = Object.values(slotsPerShift).reduce((sum, n) => sum + n, 0);
  return {
    academicYear: year.name,
    classes: classes.map((c) => {
      const missing = c.grade.gradeSubjects
        .filter((gs) => gs.weeklyPeriods !== null)
        .map((gs) => ({ subject: gs.subject.code, required: gs.weeklyPeriods!, scheduled: c.timetableEntries.filter((e) => e.subjectId === gs.subjectId).length }))
        .filter((q) => q.scheduled < q.required);
      return {
        classSectionId: c.id,
        name: className(c),
        shift: c.shift,
        slots: c.shift ? (slotsPerShift[c.shift] ?? 0) : allSlots,
        lessons: c.timetableEntries.length,
        quotaPeriods: c.grade.gradeSubjects.reduce((s, gs) => s + (gs.weeklyPeriods ?? 0), 0),
        lessonsWithoutTeacher: c.timetableEntries.filter((e) => !e.staffProfileId).length,
        missing,
        complete: missing.length === 0 && c.timetableEntries.length > 0,
      };
    }),
  };
}
