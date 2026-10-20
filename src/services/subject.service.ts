import { Errors } from '../constants/errors';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

export interface CreateSubjectInput {
  code: string; // e.g. "MATH" — permanent
  khmerName: string;
  latinName: string;
  isCoreSubject?: boolean;
}

// code is not updatable: it is the subject's stable identifier
export type UpdateSubjectInput = Partial<Omit<CreateSubjectInput, 'code'>>;

export interface ListSubjectsFilter {
  search?: string; // code, Khmer or Latin name
  gradeId?: string;
  isCoreSubject?: boolean;
}

const withGrades = {
  gradeSubjects: {
    select: { grade: { select: { id: true, gradeNumber: true, level: true } } },
    orderBy: { grade: { gradeNumber: 'asc' } },
  },
} satisfies Prisma.SubjectInclude;

type SubjectWithGrades = Prisma.SubjectGetPayload<{ include: typeof withGrades }>;

const toDto = ({ gradeSubjects, ...subject }: SubjectWithGrades) => ({
  ...subject,
  grades: gradeSubjects.map((gs) => gs.grade),
});


async function loadSubject(id: string) {
  const subject = await prisma.subject.findUnique({ where: { id }, include: withGrades });
  if (!subject) throw Errors.SUBJECT_NOT_FOUND();
  return subject;
}

export async function listSubjects(filter: ListSubjectsFilter = {}) {
  const subjects = await prisma.subject.findMany({
    where: {
      isCoreSubject: filter.isCoreSubject,
      ...(filter.gradeId && { gradeSubjects: { some: { gradeId: filter.gradeId } } }),
      ...(filter.search && {
        OR: [
          { code: { contains: filter.search, mode: 'insensitive' } },
          { khmerName: { contains: filter.search } },
          { latinName: { contains: filter.search, mode: 'insensitive' } },
        ],
      }),
    },
    include: withGrades,
    orderBy: [{ isCoreSubject: 'desc' }, { code: 'asc' }],
  });
  return subjects.map(toDto);
}

export async function getSubject(id: string) {
  return toDto(await loadSubject(id));
}

export async function createSubject(data: CreateSubjectInput) {
  const codeTaken = () => Errors.SUBJECT_CODE_EXISTS(data.code);
  if (await prisma.subject.findUnique({ where: { code: data.code } })) throw codeTaken();
  try {
    return toDto(await prisma.subject.create({ data, include: withGrades }));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw codeTaken();
    throw err;
  }
}

export async function updateSubject(id: string, data: UpdateSubjectInput) {
  await loadSubject(id);
  return toDto(await prisma.subject.update({ where: { id }, data, include: withGrades }));
}

// A subject still taught in a grade must be unassigned first, so curricula aren't changed by accident
export async function deleteSubject(id: string) {
  const subject = await loadSubject(id);
  if (subject.gradeSubjects.length > 0) {
    throw Errors.SUBJECT_IN_USE(
      subject.latinName,
      subject.gradeSubjects.map((gs) => gs.grade.gradeNumber),
    );
  }
  await prisma.subject.delete({ where: { id } });
}

/** Assign to one or more grades. Grades that already have the subject are reported, not treated as errors. */
export async function assignToGrades(id: string, gradeIds: string[]) {
  const subject = await loadSubject(id);
  const grades = await prisma.grade.findMany({ where: { id: { in: gradeIds } } });
  const missing = gradeIds.filter((gid) => !grades.some((g) => g.id === gid));
  if (missing.length) throw Errors.GRADES_NOT_FOUND(missing);

  const alreadyAssigned = grades.filter((g) => subject.gradeSubjects.some((gs) => gs.grade.id === g.id));
  await prisma.gradeSubject.createMany({ data: gradeIds.map((gradeId) => ({ gradeId, subjectId: id })), skipDuplicates: true });

  return {
    subject: await getSubject(id),
    assigned: grades.filter((g) => !alreadyAssigned.includes(g)).map((g) => g.gradeNumber).sort((a, b) => a - b),
    alreadyAssigned: alreadyAssigned.map((g) => g.gradeNumber).sort((a, b) => a - b),
  };
}

export async function unassignFromGrade(id: string, gradeId: string) {
  const subject = await loadSubject(id);
  const link = subject.gradeSubjects.find((gs) => gs.grade.id === gradeId);
  if (!link) {
    const grade = await prisma.grade.findUnique({ where: { id: gradeId } });
    if (!grade) throw Errors.GRADE_NOT_FOUND();
    throw Errors.NOT_ASSIGNED(subject.latinName, grade.gradeNumber);
  }
  await prisma.gradeSubject.delete({ where: { gradeId_subjectId: { gradeId, subjectId: id } } });
  return getSubject(id);
}
