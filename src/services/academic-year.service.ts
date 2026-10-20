import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';

export interface AcademicYearInput {
  name: string; // e.g., "2026-2027"
  startDate: Date;
  endDate: Date;
  status?: AcademicYearStatus;
}

const withCounts = { _count: { select: { classes: true, enrollments: true } } } as const;

const notFound = () => new HttpError(404, 'ACADEMIC_YEAR_NOT_FOUND', 'Academic year not found');

function validateYear({ name, startDate, endDate }: Pick<AcademicYearInput, 'name' | 'startDate' | 'endDate'>) {
  const match = /^(\d{4})-(\d{4})$/.exec(name);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'name must be two consecutive years, e.g. "2026-2027"', { field: 'name' });
  }
  if (endDate <= startDate) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'endDate must be after startDate', { field: 'endDate' });
  }
}

async function assertNameFree(tx: Prisma.TransactionClient, name: string) {
  if (await tx.academicYear.findUnique({ where: { name } })) {
    throw new HttpError(409, 'ACADEMIC_YEAR_EXISTS', `Academic year ${name} already exists`);
  }
}

// Only one academic year may be ACTIVE at a time
async function assertNoOtherActive(tx: Prisma.TransactionClient, excludeId?: string) {
  const active = await tx.academicYear.findFirst({
    where: { status: AcademicYearStatus.ACTIVE, ...(excludeId && { id: { not: excludeId } }) },
  });
  if (active) {
    throw new HttpError(409, 'ACTIVE_YEAR_EXISTS', `Academic year ${active.name} is already active; complete it first`);
  }
}

// Serializable so two concurrent requests can't both activate a year
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new HttpError(409, 'CONFLICT', 'Another change was made at the same time; please retry');
    }
    throw err;
  }
}

export function listAcademicYears(filter: { status?: AcademicYearStatus } = {}) {
  return prisma.academicYear.findMany({
    where: { status: filter.status },
    orderBy: { startDate: 'desc' },
    include: withCounts,
  });
}

export async function getAcademicYear(id: string) {
  const year = await prisma.academicYear.findUnique({
    where: { id },
    include: {
      ...withCounts,
      classes: {
        select: { id: true, sectionName: true, maxCapacity: true, grade: { select: { id: true, gradeNumber: true } } },
        orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
      },
    },
  });
  if (!year) throw notFound();
  return year;
}

export function createAcademicYear(data: AcademicYearInput) {
  validateYear(data);
  return serializable(async (tx) => {
    await assertNameFree(tx, data.name);
    if (data.status === AcademicYearStatus.ACTIVE) await assertNoOtherActive(tx);
    return tx.academicYear.create({ data, include: withCounts });
  });
}

export function updateAcademicYear(id: string, data: Partial<AcademicYearInput>) {
  return serializable(async (tx) => {
    const year = await tx.academicYear.findUnique({ where: { id } });
    if (!year) throw notFound();

    const merged = {
      name: data.name ?? year.name,
      startDate: data.startDate ?? year.startDate,
      endDate: data.endDate ?? year.endDate,
      status: data.status ?? year.status,
    };
    validateYear(merged);

    if (merged.name !== year.name) await assertNameFree(tx, merged.name);
    if (merged.status === AcademicYearStatus.ACTIVE && year.status !== AcademicYearStatus.ACTIVE) {
      await assertNoOtherActive(tx, id);
    }

    return tx.academicYear.update({ where: { id }, data: merged, include: withCounts });
  });
}

export async function deleteAcademicYear(id: string) {
  const year = await prisma.academicYear.findUnique({ where: { id }, include: withCounts });
  if (!year) throw notFound();
  if (year._count.classes > 0 || year._count.enrollments > 0) {
    throw new HttpError(
      409,
      'ACADEMIC_YEAR_IN_USE',
      `Academic year ${year.name} has ${year._count.classes} class section(s) and ${year._count.enrollments} enrollment(s); it cannot be deleted`,
    );
  }
  await prisma.academicYear.delete({ where: { id } });
}
