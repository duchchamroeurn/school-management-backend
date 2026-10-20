import { Errors } from '../constants/errors';
import { educationLevelOf as levelFor } from '../constants/school-levels';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';
import { assertGradeOffered } from './school-settings.service';

// Secondary school only: grades 7–9 are lower secondary, 10–12 upper secondary
export const MIN_GRADE = 7;
export const MAX_GRADE = 12;

const withCounts = { _count: { select: { classes: true, gradeSubjects: true } } } as const;

const auditGrade = (g: { id: string; gradeNumber: number }) => ({ entityType: 'Grade', entityId: g.id, entityLabel: `Grade ${g.gradeNumber}` }) as const;


export function listGrades() {
  return prisma.grade.findMany({ orderBy: { gradeNumber: 'asc' }, include: withCounts });
}

export async function getGrade(id: string) {
  const grade = await prisma.grade.findUnique({
    where: { id },
    include: {
      ...withCounts,
      gradeSubjects: {
        include: { subject: true },
        orderBy: { subject: { code: 'asc' } },
      },
    },
  });
  if (!grade) throw Errors.GRADE_NOT_FOUND();

  const { gradeSubjects, ...rest } = grade;
  return { ...rest, subjects: gradeSubjects.map((gs) => gs.subject) };
}

export async function createGrade(data: { gradeNumber: number }) {
  await assertGradeOffered(data.gradeNumber);
  if (await prisma.grade.findUnique({ where: { gradeNumber: data.gradeNumber } })) {
    throw Errors.GRADE_EXISTS(data.gradeNumber);
  }
  return prisma.$transaction(async (tx) => {
    const created = await tx.grade.create({
      data: { gradeNumber: data.gradeNumber, level: levelFor(data.gradeNumber) },
      include: withCounts,
    });
    await audit(tx, { ...auditGrade(created), action: 'GRADE_CREATED', after: scalars(created) });
    return created;
  });
}

export async function updateGrade(id: string, data: { gradeNumber?: number }) {
  const grade = await prisma.grade.findUnique({ where: { id } });
  if (!grade) throw Errors.GRADE_NOT_FOUND();

  if (data.gradeNumber !== undefined && data.gradeNumber !== grade.gradeNumber) {
    await assertGradeOffered(data.gradeNumber);
    if (await prisma.grade.findUnique({ where: { gradeNumber: data.gradeNumber } })) {
      throw Errors.GRADE_EXISTS(data.gradeNumber);
    }
  }

  const gradeNumber = data.gradeNumber ?? grade.gradeNumber;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.grade.update({
      where: { id },
      data: { gradeNumber, level: levelFor(gradeNumber) },
      include: withCounts,
    });
    await audit(tx, { ...auditGrade(updated), action: 'GRADE_UPDATED', before: scalars(grade), after: scalars(updated) });
    return updated;
  });
}

export async function deleteGrade(id: string) {
  const grade = await prisma.grade.findUnique({ where: { id }, include: withCounts });
  if (!grade) throw Errors.GRADE_NOT_FOUND();
  if (grade._count.classes > 0) {
    throw Errors.GRADE_IN_USE(grade.gradeNumber, grade._count.classes);
  }
  // grade_subjects rows cascade
  await prisma.$transaction(async (tx) => {
    await tx.grade.delete({ where: { id } });
    await audit(tx, { ...auditGrade(grade), action: 'GRADE_DELETED', before: scalars(grade) });
  });
}
