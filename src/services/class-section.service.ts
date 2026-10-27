import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma, Shift } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';

export interface CreateClassSectionInput {
  sectionName: string; // e.g., "A"
  maxCapacity: number;
  gradeId: string;
  academicYearId: string;
  homeroomTeacherId?: string | null; // StaffProfile id
  shift?: Shift | null; // null (default) = the whole day; MORNING / AFTERNOON = a half-day class
  roomId?: string | null; // home room
}

// Grade and academic year are fixed once created; move students by enrolling them elsewhere instead
export interface UpdateClassSectionInput {
  sectionName?: string;
  maxCapacity?: number;
  homeroomTeacherId?: string | null; // null = remove homeroom teacher
  shift?: Shift | null; // to a half day only while it has no lessons in the other shift
  roomId?: string | null; // null = no home room
}

export const MAX_CAPACITY_LIMIT = 100;

export const classSectionDetails = {
  grade: true,
  academicYear: { select: { id: true, name: true, status: true } },
  homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
  room: { select: { id: true, name: true } },
  _count: { select: { enrollments: true } },
} as const;

type ClassSectionWithDetails = Prisma.ClassSectionGetPayload<{ include: typeof classSectionDetails }>;

const auditSnapshot = (c: ClassSectionWithDetails) => ({
  ...scalars(c, ['room']), // roomId is kept; the included room relation is not
  homeroomTeacher: c.homeroomTeacher && `${c.homeroomTeacher.latinName} (${c.homeroomTeacher.khmerName})`,
});

const auditClassSection = (c: ClassSectionWithDetails) =>
  ({ entityType: 'ClassSection', entityId: c.id, entityLabel: `${c.grade.gradeNumber}${c.sectionName} ${c.academicYear.name}` }) as const;


const classSectionExists = (gradeNumber: number, sectionName: string, academicYearName: string) =>
  Errors.CLASS_SECTION_EXISTS(`${gradeNumber}${sectionName}`, academicYearName);

const yearClosed = (academicYearName: string) =>
  Errors.ACADEMIC_YEAR_CLOSED(academicYearName, 'its classes');

// Normalise so "a", " A" and "A" can't become three different sections
function normaliseSectionName(sectionName: string) {
  const normalised = sectionName.trim().toUpperCase();
  if (!normalised) throw Errors.SECTION_NAME_REQUIRED();
  return normalised;
}

function assertCapacity(maxCapacity: number) {
  if (!Number.isInteger(maxCapacity) || maxCapacity < 1 || maxCapacity > MAX_CAPACITY_LIMIT) {
    throw Errors.CAPACITY_OUT_OF_RANGE(MAX_CAPACITY_LIMIT);
  }
}

async function assertTeacherExists(homeroomTeacherId: string) {
  if (!(await prisma.staffProfile.findUnique({ where: { id: homeroomTeacherId } }))) {
    throw Errors.TEACHER_NOT_FOUND();
  }
}

/** A teacher may be homeroom teacher of only one class per academic year (also enforced by a DB unique constraint). */
export async function assertTeacherFreeForYear(homeroomTeacherId: string, academicYearId: string, exceptClassSectionId?: string) {
  const other = await prisma.classSection.findFirst({
    where: { homeroomTeacherId, academicYearId, ...(exceptClassSectionId && { id: { not: exceptClassSectionId } }) },
    include: { grade: true, academicYear: true, homeroomTeacher: true },
  });
  if (other) {
    throw Errors.TEACHER_ALREADY_ASSIGNED(other.homeroomTeacher!, `${other.grade.gradeNumber}${other.sectionName}`, other.academicYear.name, other.id);
  }
}

/**
 * A room is used all day by a full-day class, so it can't hold any other class that year; two half-day classes
 * share it only when they are in different shifts (that pair is also a DB unique constraint).
 */
async function assertRoomFree(roomId: string, shift: Shift | null, academicYearId: string, exceptClassSectionId?: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw Errors.ROOM_NOT_FOUND();
  const other = await prisma.classSection.findFirst({
    where: {
      roomId,
      academicYearId,
      // A full-day class clashes with anyone; a half-day class with the same shift or a full-day class
      ...(shift && { OR: [{ shift }, { shift: null }] }),
      ...(exceptClassSectionId && { id: { not: exceptClassSectionId } }),
    },
    include: { grade: true },
  });
  if (other) throw Errors.ROOM_SHIFT_TAKEN(room.name, `${other.grade.gradeNumber}${other.sectionName}`, other.shift);
}

async function assertNameFree(gradeId: string, sectionName: string, academicYearId: string, exceptClassSectionId?: string) {
  const duplicate = await prisma.classSection.findUnique({
    where: { gradeId_sectionName_academicYearId: { gradeId, sectionName, academicYearId } },
    include: { grade: true, academicYear: true },
  });
  if (duplicate && duplicate.id !== exceptClassSectionId) {
    throw classSectionExists(duplicate.grade.gradeNumber, sectionName, duplicate.academicYear.name);
  }
}

/**
 * Two requests can pass the pre-checks at the same time; the DB unique constraints are the final guard.
 * On a unique violation, re-run the checks so the caller gets the specific error (duplicate name vs teacher already assigned).
 */
export async function guardUnique<T>(write: () => Promise<T>, recheck: () => Promise<void>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await recheck();
      throw Errors.CONFLICT();
    }
    throw err;
  }
}

export function listClassSections(filter: { academicYearId?: string; gradeId?: string } = {}) {
  return prisma.classSection.findMany({
    where: { academicYearId: filter.academicYearId, gradeId: filter.gradeId },
    include: classSectionDetails,
    orderBy: [{ academicYear: { startDate: 'desc' } }, { grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
}

export async function getClassSection(id: string) {
  const classSection = await prisma.classSection.findUnique({ where: { id }, include: classSectionDetails });
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
  return classSection;
}

export async function createClassSection(data: CreateClassSectionInput) {
  const sectionName = normaliseSectionName(data.sectionName);
  assertCapacity(data.maxCapacity);

  const [grade, academicYear] = await Promise.all([
    prisma.grade.findUnique({ where: { id: data.gradeId } }),
    prisma.academicYear.findUnique({ where: { id: data.academicYearId } }),
  ]);
  if (!grade) throw Errors.GRADE_NOT_FOUND();
  if (!academicYear) throw Errors.ACADEMIC_YEAR_NOT_FOUND();
  if (academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(academicYear.name);

  const checks = async () => {
    await assertNameFree(grade.id, sectionName, academicYear.id);
    if (data.homeroomTeacherId) await assertTeacherFreeForYear(data.homeroomTeacherId, academicYear.id);
    if (data.roomId) await assertRoomFree(data.roomId, data.shift ?? null, academicYear.id);
  };
  if (data.homeroomTeacherId) await assertTeacherExists(data.homeroomTeacherId);
  await checks();

  return guardUnique(
    () =>
      prisma.$transaction(async (tx) => {
        const created = await tx.classSection.create({
          data: {
            sectionName,
            maxCapacity: data.maxCapacity,
            gradeId: grade.id,
            academicYearId: academicYear.id,
            homeroomTeacherId: data.homeroomTeacherId ?? null,
            shift: data.shift ?? null,
            roomId: data.roomId ?? null,
          },
          include: classSectionDetails,
        });
        await audit(tx, { ...auditClassSection(created), action: 'CLASS_SECTION_CREATED', after: auditSnapshot(created) });
        return created;
      }),
    checks,
  );
}

export async function updateClassSection(id: string, data: UpdateClassSectionInput) {
  const existing = await getClassSection(id);
  if (existing.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(existing.academicYear.name);

  const sectionName = data.sectionName === undefined ? undefined : normaliseSectionName(data.sectionName);

  if (data.maxCapacity !== undefined) {
    assertCapacity(data.maxCapacity);
    if (data.maxCapacity < existing._count.enrollments) {
      throw Errors.CAPACITY_BELOW_ENROLLMENT(existing._count.enrollments);
    }
  }

  // Becoming a full-day class only adds slots; becoming a half-day class loses the other shift's lessons
  if (data.shift && data.shift !== existing.shift) {
    const lessons = await prisma.timetableEntry.count({ where: { classSectionId: id, timeSlot: { shift: { not: data.shift } } } });
    if (lessons) throw Errors.CLASS_HAS_TIMETABLE(`${existing.grade.gradeNumber}${existing.sectionName}`, lessons, data.shift);
  }
  const roomId = data.roomId === undefined ? existing.roomId : data.roomId;
  const shift = data.shift === undefined ? existing.shift : data.shift;

  const checks = async () => {
    if (sectionName !== undefined) await assertNameFree(existing.gradeId, sectionName, existing.academicYearId, id);
    if (data.homeroomTeacherId) await assertTeacherFreeForYear(data.homeroomTeacherId, existing.academicYearId, id);
    if (roomId && (roomId !== existing.roomId || shift !== existing.shift)) await assertRoomFree(roomId, shift, existing.academicYearId, id);
  };
  if (data.homeroomTeacherId) await assertTeacherExists(data.homeroomTeacherId);
  await checks();

  return guardUnique(
    () =>
      prisma.$transaction(async (tx) => {
        const updated = await tx.classSection.update({
          where: { id },
          data: { sectionName, maxCapacity: data.maxCapacity, homeroomTeacherId: data.homeroomTeacherId, shift: data.shift, roomId: data.roomId },
          include: classSectionDetails,
        });
        await audit(tx, { ...auditClassSection(updated), action: 'CLASS_SECTION_UPDATED', before: auditSnapshot(existing), after: auditSnapshot(updated) });
        return updated;
      }),
    checks,
  );
}

export async function deleteClassSection(id: string) {
  const existing = await getClassSection(id);
  if (existing.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(existing.academicYear.name);
  if (existing._count.enrollments > 0) {
    throw Errors.CLASS_SECTION_IN_USE(`${existing.grade.gradeNumber}${existing.sectionName}`, existing._count.enrollments);
  }
  await prisma.$transaction(async (tx) => {
    await tx.classSection.delete({ where: { id } });
    await audit(tx, { ...auditClassSection(existing), action: 'CLASS_SECTION_DELETED', before: auditSnapshot(existing) });
  });
}
