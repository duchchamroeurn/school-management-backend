import { Errors } from '../constants/errors';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit, scalars } from './audit.service';

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
    select: { weeklyPeriods: true, grade: { select: { id: true, gradeNumber: true, level: true } } },
    orderBy: { grade: { gradeNumber: 'asc' } },
  },
} satisfies Prisma.SubjectInclude;

type SubjectWithGrades = Prisma.SubjectGetPayload<{ include: typeof withGrades }>;

const toDto = ({ gradeSubjects, ...subject }: SubjectWithGrades) => ({
  ...subject,
  grades: gradeSubjects.map((gs) => ({ ...gs.grade, weeklyPeriods: gs.weeklyPeriods })),
});

const auditSubject = (s: { id: string; code: string; latinName: string }) =>
  ({ entityType: 'Subject', entityId: s.id, entityLabel: `${s.code} ${s.latinName}` }) as const;


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
    return toDto(
      await prisma.$transaction(async (tx) => {
        const created = await tx.subject.create({ data, include: withGrades });
        await audit(tx, { ...auditSubject(created), action: 'SUBJECT_CREATED', after: scalars(created) });
        return created;
      }),
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw codeTaken();
    throw err;
  }
}

export async function updateSubject(id: string, data: UpdateSubjectInput) {
  const current = await loadSubject(id);
  return toDto(
    await prisma.$transaction(async (tx) => {
      const updated = await tx.subject.update({ where: { id }, data, include: withGrades });
      await audit(tx, { ...auditSubject(updated), action: 'SUBJECT_UPDATED', before: scalars(current), after: scalars(updated) });
      return updated;
    }),
  );
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
  await prisma.$transaction(async (tx) => {
    await tx.subject.delete({ where: { id } });
    await audit(tx, { ...auditSubject(subject), action: 'SUBJECT_DELETED', before: scalars(subject) });
  });
}

/** Assign to one or more grades. Grades that already have the subject are reported, not treated as errors. */
export async function assignToGrades(id: string, gradeIds: string[]) {
  const subject = await loadSubject(id);
  const grades = await prisma.grade.findMany({ where: { id: { in: gradeIds } } });
  const missing = gradeIds.filter((gid) => !grades.some((g) => g.id === gid));
  if (missing.length) throw Errors.GRADES_NOT_FOUND(missing);

  const alreadyAssigned = grades.filter((g) => subject.gradeSubjects.some((gs) => gs.grade.id === g.id));
  const newlyAssigned = grades.filter((g) => !alreadyAssigned.includes(g)).map((g) => g.gradeNumber).sort((a, b) => a - b);
  await prisma.$transaction(async (tx) => {
    await tx.gradeSubject.createMany({ data: gradeIds.map((gradeId) => ({ gradeId, subjectId: id })), skipDuplicates: true });
    if (newlyAssigned.length) {
      await audit(tx, { ...auditSubject(subject), action: 'SUBJECT_GRADES_ASSIGNED', after: { grades: newlyAssigned } });
    }
  });

  return {
    subject: await getSubject(id),
    assigned: newlyAssigned,
    alreadyAssigned: alreadyAssigned.map((g) => g.gradeNumber).sort((a, b) => a - b),
  };
}

/** MoEYS hourly quota: lessons of the subject per week in that grade (null = none set). Checked by the timetable. */
export async function setWeeklyPeriods(id: string, gradeId: string, weeklyPeriods: number | null) {
  const subject = await loadSubject(id);
  const link = subject.gradeSubjects.find((gs) => gs.grade.id === gradeId);
  if (!link) {
    const grade = await prisma.grade.findUnique({ where: { id: gradeId } });
    if (!grade) throw Errors.GRADE_NOT_FOUND();
    throw Errors.NOT_ASSIGNED(subject.latinName, grade.gradeNumber);
  }
  await prisma.$transaction(async (tx) => {
    await tx.gradeSubject.update({ where: { gradeId_subjectId: { gradeId, subjectId: id } }, data: { weeklyPeriods } });
    await audit(tx, {
      ...auditSubject(subject),
      action: 'SUBJECT_QUOTA_SET',
      before: { grade: link.grade.gradeNumber, weeklyPeriods: link.weeklyPeriods },
      after: { grade: link.grade.gradeNumber, weeklyPeriods },
    });
  });
  return getSubject(id);
}

export async function unassignFromGrade(id: string, gradeId: string) {
  const subject = await loadSubject(id);
  const link = subject.gradeSubjects.find((gs) => gs.grade.id === gradeId);
  if (!link) {
    const grade = await prisma.grade.findUnique({ where: { id: gradeId } });
    if (!grade) throw Errors.GRADE_NOT_FOUND();
    throw Errors.NOT_ASSIGNED(subject.latinName, grade.gradeNumber);
  }
  await prisma.$transaction(async (tx) => {
    await tx.gradeSubject.delete({ where: { gradeId_subjectId: { gradeId, subjectId: id } } });
    await audit(tx, { ...auditSubject(subject), action: 'SUBJECT_GRADE_UNASSIGNED', before: { grade: link.grade.gradeNumber } });
  });
  return getSubject(id);
}
