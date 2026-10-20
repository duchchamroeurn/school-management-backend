import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';

export interface CreateClassSectionInput {
  sectionName: string; // e.g., "A"
  maxCapacity: number;
  gradeId: string;
  academicYearId: string;
  homeroomTeacherId?: string | null; // StaffProfile id
}

// Grade and academic year are fixed once created; move students by enrolling them elsewhere instead
export interface UpdateClassSectionInput {
  sectionName?: string;
  maxCapacity?: number;
  homeroomTeacherId?: string | null; // null = remove homeroom teacher
}

export const MAX_CAPACITY_LIMIT = 100;

export const classSectionDetails = {
  grade: true,
  academicYear: { select: { id: true, name: true, status: true } },
  homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
  _count: { select: { enrollments: true } },
} as const;

const notFound = () => new HttpError(404, 'CLASS_SECTION_NOT_FOUND', 'Class section not found');

const classSectionExists = (gradeNumber: number, sectionName: string, academicYearName: string) =>
  new HttpError(
    409,
    'CLASS_SECTION_EXISTS',
    `Class ${gradeNumber}${sectionName} already exists for academic year ${academicYearName}`,
  );

const yearClosed = (academicYearName: string) =>
  new HttpError(409, 'ACADEMIC_YEAR_CLOSED', `Academic year ${academicYearName} is completed; its classes can no longer be changed`);

// Normalise so "a", " A" and "A" can't become three different sections
function normaliseSectionName(sectionName: string) {
  const normalised = sectionName.trim().toUpperCase();
  if (!normalised) throw new HttpError(400, 'VALIDATION_ERROR', 'sectionName is required');
  return normalised;
}

function assertCapacity(maxCapacity: number) {
  if (!Number.isInteger(maxCapacity) || maxCapacity < 1 || maxCapacity > MAX_CAPACITY_LIMIT) {
    throw new HttpError(400, 'VALIDATION_ERROR', `maxCapacity must be a whole number between 1 and ${MAX_CAPACITY_LIMIT}`);
  }
}

async function assertTeacherExists(homeroomTeacherId: string) {
  if (!(await prisma.staffProfile.findUnique({ where: { id: homeroomTeacherId } }))) {
    throw new HttpError(404, 'TEACHER_NOT_FOUND', 'Homeroom teacher (staff profile) not found');
  }
}

/** A teacher may be homeroom teacher of only one class per academic year (also enforced by a DB unique constraint). */
export async function assertTeacherFreeForYear(homeroomTeacherId: string, academicYearId: string, exceptClassSectionId?: string) {
  const other = await prisma.classSection.findFirst({
    where: { homeroomTeacherId, academicYearId, ...(exceptClassSectionId && { id: { not: exceptClassSectionId } }) },
    include: { grade: true, academicYear: true, homeroomTeacher: true },
  });
  if (other) {
    throw new HttpError(
      409,
      'TEACHER_ALREADY_ASSIGNED',
      `${other.homeroomTeacher!.latinName} (${other.homeroomTeacher!.khmerName}) is already homeroom teacher of class ${other.grade.gradeNumber}${other.sectionName} in ${other.academicYear.name}`,
      { classSectionId: other.id },
    );
  }
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
      throw new HttpError(409, 'CONFLICT', 'A conflicting change was made at the same time; please retry');
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
  if (!classSection) throw notFound();
  return classSection;
}

export async function createClassSection(data: CreateClassSectionInput) {
  const sectionName = normaliseSectionName(data.sectionName);
  assertCapacity(data.maxCapacity);

  const [grade, academicYear] = await Promise.all([
    prisma.grade.findUnique({ where: { id: data.gradeId } }),
    prisma.academicYear.findUnique({ where: { id: data.academicYearId } }),
  ]);
  if (!grade) throw new HttpError(404, 'GRADE_NOT_FOUND', 'Grade not found');
  if (!academicYear) throw new HttpError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');
  if (academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(academicYear.name);

  const checks = async () => {
    await assertNameFree(grade.id, sectionName, academicYear.id);
    if (data.homeroomTeacherId) await assertTeacherFreeForYear(data.homeroomTeacherId, academicYear.id);
  };
  if (data.homeroomTeacherId) await assertTeacherExists(data.homeroomTeacherId);
  await checks();

  return guardUnique(
    () =>
      prisma.classSection.create({
        data: {
          sectionName,
          maxCapacity: data.maxCapacity,
          gradeId: grade.id,
          academicYearId: academicYear.id,
          homeroomTeacherId: data.homeroomTeacherId ?? null,
        },
        include: classSectionDetails,
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
      throw new HttpError(
        409,
        'CAPACITY_BELOW_ENROLLMENT',
        `maxCapacity cannot be lower than the ${existing._count.enrollments} student(s) already enrolled`,
      );
    }
  }

  const checks = async () => {
    if (sectionName !== undefined) await assertNameFree(existing.gradeId, sectionName, existing.academicYearId, id);
    if (data.homeroomTeacherId) await assertTeacherFreeForYear(data.homeroomTeacherId, existing.academicYearId, id);
  };
  if (data.homeroomTeacherId) await assertTeacherExists(data.homeroomTeacherId);
  await checks();

  return guardUnique(
    () =>
      prisma.classSection.update({
        where: { id },
        data: { sectionName, maxCapacity: data.maxCapacity, homeroomTeacherId: data.homeroomTeacherId },
        include: classSectionDetails,
      }),
    checks,
  );
}

export async function deleteClassSection(id: string) {
  const existing = await getClassSection(id);
  if (existing.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(existing.academicYear.name);
  if (existing._count.enrollments > 0) {
    throw new HttpError(
      409,
      'CLASS_SECTION_IN_USE',
      `Class ${existing.grade.gradeNumber}${existing.sectionName} has ${existing._count.enrollments} enrolled student(s); it cannot be deleted`,
    );
  }
  await prisma.classSection.delete({ where: { id } });
}
