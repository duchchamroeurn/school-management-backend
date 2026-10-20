import { educationLevelOf as levelFor } from '../constants/school-levels';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';
import { assertGradeOffered } from './school-settings.service';

// Secondary school only: grades 7–9 are lower secondary, 10–12 upper secondary
export const MIN_GRADE = 7;
export const MAX_GRADE = 12;

const withCounts = { _count: { select: { classes: true, gradeSubjects: true } } } as const;

const notFound = () => new HttpError(404, 'GRADE_NOT_FOUND', 'Grade not found');
const alreadyExists = (gradeNumber: number) =>
  new HttpError(409, 'GRADE_EXISTS', `Grade ${gradeNumber} already exists`);

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
  if (!grade) throw notFound();

  const { gradeSubjects, ...rest } = grade;
  return { ...rest, subjects: gradeSubjects.map((gs) => gs.subject) };
}

export async function createGrade(data: { gradeNumber: number }) {
  await assertGradeOffered(data.gradeNumber);
  if (await prisma.grade.findUnique({ where: { gradeNumber: data.gradeNumber } })) {
    throw alreadyExists(data.gradeNumber);
  }
  return prisma.grade.create({
    data: { gradeNumber: data.gradeNumber, level: levelFor(data.gradeNumber) },
    include: withCounts,
  });
}

export async function updateGrade(id: string, data: { gradeNumber?: number }) {
  const grade = await prisma.grade.findUnique({ where: { id } });
  if (!grade) throw notFound();

  if (data.gradeNumber !== undefined && data.gradeNumber !== grade.gradeNumber) {
    await assertGradeOffered(data.gradeNumber);
    if (await prisma.grade.findUnique({ where: { gradeNumber: data.gradeNumber } })) {
      throw alreadyExists(data.gradeNumber);
    }
  }

  const gradeNumber = data.gradeNumber ?? grade.gradeNumber;
  return prisma.grade.update({
    where: { id },
    data: { gradeNumber, level: levelFor(gradeNumber) },
    include: withCounts,
  });
}

export async function deleteGrade(id: string) {
  const grade = await prisma.grade.findUnique({ where: { id }, include: withCounts });
  if (!grade) throw notFound();
  if (grade._count.classes > 0) {
    throw new HttpError(
      409,
      'GRADE_IN_USE',
      `Grade ${grade.gradeNumber} has ${grade._count.classes} class section(s); delete those first`,
    );
  }
  // grade_subjects rows cascade
  await prisma.grade.delete({ where: { id } });
}
