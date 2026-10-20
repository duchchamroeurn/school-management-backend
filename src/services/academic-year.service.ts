import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';

export interface AcademicYearInput {
  name: string; // e.g., "2026-2027"
  startDate: Date;
  endDate: Date;
  status?: AcademicYearStatus;
}

const withCounts = { _count: { select: { classes: true, enrollments: true } } } as const;

const auditYear = (y: { id: string; name: string }) => ({ entityType: 'AcademicYear', entityId: y.id, entityLabel: y.name }) as const;


function validateYear({ name, startDate, endDate }: Pick<AcademicYearInput, 'name' | 'startDate' | 'endDate'>) {
  const match = /^(\d{4})-(\d{4})$/.exec(name);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) {
    throw Errors.YEAR_NAME_FORMAT();
  }
  if (endDate <= startDate) {
    throw Errors.END_BEFORE_START();
  }
}

async function assertNameFree(tx: Prisma.TransactionClient, name: string) {
  if (await tx.academicYear.findUnique({ where: { name } })) {
    throw Errors.ACADEMIC_YEAR_EXISTS(name);
  }
}

// Only one academic year may be ACTIVE at a time
async function assertNoOtherActive(tx: Prisma.TransactionClient, excludeId?: string) {
  const active = await tx.academicYear.findFirst({
    where: { status: AcademicYearStatus.ACTIVE, ...(excludeId && { id: { not: excludeId } }) },
  });
  if (active) {
    throw Errors.ACTIVE_YEAR_EXISTS(active.name);
  }
}

// Serializable so two concurrent requests can't both activate a year
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw Errors.CONFLICT();
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
  if (!year) throw Errors.ACADEMIC_YEAR_NOT_FOUND();
  return year;
}

export function createAcademicYear(data: AcademicYearInput) {
  validateYear(data);
  return serializable(async (tx) => {
    await assertNameFree(tx, data.name);
    if (data.status === AcademicYearStatus.ACTIVE) await assertNoOtherActive(tx);
    const created = await tx.academicYear.create({ data, include: withCounts });
    await audit(tx, { ...auditYear(created), action: 'ACADEMIC_YEAR_CREATED', after: scalars(created) });
    return created;
  });
}

export function updateAcademicYear(id: string, data: Partial<AcademicYearInput>) {
  return serializable(async (tx) => {
    const year = await tx.academicYear.findUnique({ where: { id } });
    if (!year) throw Errors.ACADEMIC_YEAR_NOT_FOUND();

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

    const updated = await tx.academicYear.update({ where: { id }, data: merged, include: withCounts });
    await audit(tx, { ...auditYear(updated), action: 'ACADEMIC_YEAR_UPDATED', before: scalars(year), after: scalars(updated) });
    return updated;
  });
}

export async function deleteAcademicYear(id: string) {
  const year = await prisma.academicYear.findUnique({ where: { id }, include: withCounts });
  if (!year) throw Errors.ACADEMIC_YEAR_NOT_FOUND();
  if (year._count.classes > 0 || year._count.enrollments > 0) {
    throw Errors.ACADEMIC_YEAR_IN_USE(year.name, year._count.classes, year._count.enrollments);
  }
  await prisma.$transaction(async (tx) => {
    await tx.academicYear.delete({ where: { id } });
    await audit(tx, { ...auditYear(year), action: 'ACADEMIC_YEAR_DELETED', before: scalars(year) });
  });
}
