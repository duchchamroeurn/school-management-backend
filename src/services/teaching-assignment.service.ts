// Who teaches which subject in which class. A teacher can hold many assignments (several subjects, several
// classes); each subject in a class has exactly one teacher. Score entry only accepts scores from the
// assigned teacher (or users with ENTER_ANY_SCORES).
import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';

export interface TeachingAssignmentInput {
  staffId: string;
  subjectId: string;
  classSectionId: string;
}

export interface ListTeachingAssignmentsFilter {
  staffId?: string;
  subjectId?: string;
  classSectionId?: string;
  academicYearId?: string;
}

const details = {
  staff: { select: { id: true, khmerName: true, latinName: true } },
  subject: { select: { id: true, code: true, khmerName: true, latinName: true } },
  classSection: {
    select: {
      id: true,
      sectionName: true,
      grade: { select: { id: true, gradeNumber: true } },
      academicYear: { select: { id: true, name: true, status: true } },
    },
  },
} satisfies Prisma.TeachingAssignmentInclude;

type AssignmentWithDetails = Prisma.TeachingAssignmentGetPayload<{ include: typeof details }>;

const classNameOf = (a: AssignmentWithDetails) => `${a.classSection.grade.gradeNumber}${a.classSection.sectionName}`;

const auditSnapshot = (a: AssignmentWithDetails) => ({
  staffId: a.staff.id,
  teacher: `${a.staff.latinName} (${a.staff.khmerName})`,
  subjectId: a.subject.id,
  subject: a.subject.code,
  classSectionId: a.classSection.id,
  classSection: classNameOf(a),
  academicYear: a.classSection.academicYear.name,
});

const auditAssignment = (a: AssignmentWithDetails) =>
  ({
    entityType: 'TeachingAssignment',
    entityId: a.id,
    entityLabel: `${a.subject.code} — ${classNameOf(a)} ${a.classSection.academicYear.name}`,
  }) as const;

const ORDER: Prisma.TeachingAssignmentOrderByWithRelationInput[] = [
  { classSection: { academicYear: { startDate: 'desc' } } },
  { classSection: { grade: { gradeNumber: 'asc' } } },
  { classSection: { sectionName: 'asc' } },
  { subject: { code: 'asc' } },
];

function assertYearOpen(academicYear: { name: string; status: AcademicYearStatus }) {
  if (academicYear.status === AcademicYearStatus.COMPLETED) {
    throw Errors.ACADEMIC_YEAR_CLOSED(academicYear.name, 'its teaching assignments');
  }
}

async function assertStaffExists(db: Prisma.TransactionClient, staffId: string) {
  if (!(await db.staffProfile.findUnique({ where: { id: staffId }, select: { id: true } }))) throw Errors.STAFF_NOT_FOUND();
}

async function assertSubjectFreeInClass(db: Prisma.TransactionClient, subjectId: string, classSectionId: string) {
  const existing = await db.teachingAssignment.findUnique({
    where: { subjectId_classSectionId: { subjectId, classSectionId } },
    include: details,
  });
  if (existing) {
    throw Errors.SUBJECT_ALREADY_TAUGHT(existing.subject.latinName, classNameOf(existing), existing.staff, existing.id);
  }
}

async function loadAssignment(db: Prisma.TransactionClient, id: string) {
  const assignment = await db.teachingAssignment.findUnique({ where: { id }, include: details });
  if (!assignment) throw Errors.TEACHING_ASSIGNMENT_NOT_FOUND();
  return assignment;
}

export function listTeachingAssignments(filter: ListTeachingAssignmentsFilter = {}) {
  return prisma.teachingAssignment.findMany({
    where: {
      staffId: filter.staffId,
      subjectId: filter.subjectId,
      classSectionId: filter.classSectionId,
      ...(filter.academicYearId && { classSection: { academicYearId: filter.academicYearId } }),
    },
    include: details,
    orderBy: ORDER,
  });
}

export function getTeachingAssignment(id: string) {
  return loadAssignment(prisma, id);
}

/** Assigns a teacher to teach a subject in a class. The subject must be taught in the class's grade. */
export async function createTeachingAssignment(input: TeachingAssignmentInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      await assertStaffExists(tx, input.staffId);
      const subject = await tx.subject.findUnique({ where: { id: input.subjectId } });
      if (!subject) throw Errors.SUBJECT_NOT_FOUND();
      const classSection = await tx.classSection.findUnique({
        where: { id: input.classSectionId },
        include: { academicYear: true, grade: { include: { gradeSubjects: { where: { subjectId: subject.id } } } } },
      });
      if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
      assertYearOpen(classSection.academicYear);
      if (classSection.grade.gradeSubjects.length === 0) throw Errors.SUBJECT_NOT_IN_GRADE(subject.latinName, classSection.grade.gradeNumber);
      await assertSubjectFreeInClass(tx, subject.id, classSection.id);

      const created = await tx.teachingAssignment.create({ data: input, include: details });
      await audit(tx, { ...auditAssignment(created), action: 'TEACHING_ASSIGNMENT_CREATED', after: auditSnapshot(created) });
      return created;
    });
  } catch (err) {
    // Two requests assigning the same subject and class at once: report who got it
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await assertSubjectFreeInClass(prisma, input.subjectId, input.classSectionId);
      throw Errors.CONFLICT();
    }
    throw err;
  }
}

/** Hands the subject in this class to another teacher. Scores already entered stay as they are. */
export async function reassignTeacher(id: string, staffId: string) {
  return prisma.$transaction(async (tx) => {
    const current = await loadAssignment(tx, id);
    assertYearOpen(current.classSection.academicYear);
    await assertStaffExists(tx, staffId);
    const updated = await tx.teachingAssignment.update({ where: { id }, data: { staffId }, include: details });
    await audit(tx, { ...auditAssignment(updated), action: 'TEACHING_ASSIGNMENT_UPDATED', before: auditSnapshot(current), after: auditSnapshot(updated) });
    return updated;
  });
}

export async function deleteTeachingAssignment(id: string) {
  await prisma.$transaction(async (tx) => {
    const current = await loadAssignment(tx, id);
    assertYearOpen(current.classSection.academicYear);
    await tx.teachingAssignment.delete({ where: { id } });
    await audit(tx, { ...auditAssignment(current), action: 'TEACHING_ASSIGNMENT_DELETED', before: auditSnapshot(current) });
  });
}

/** The signed-in teacher's own assignments in the given or the ACTIVE academic year. */
export async function listOwnTeachingAssignments(userId: string, academicYearName?: string) {
  const [staff, academicYear] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { userId }, select: { id: true } }),
    academicYearName
      ? prisma.academicYear.findUnique({ where: { name: academicYearName } })
      : prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } }),
  ]);
  if (!staff) throw Errors.OWN_STAFF_PROFILE_NOT_FOUND();
  if (!academicYear) {
    throw academicYearName ? Errors.ACADEMIC_YEAR_NOT_FOUND(academicYearName) : Errors.ACADEMIC_YEAR_REQUIRED();
  }
  return listTeachingAssignments({ staffId: staff.id, academicYearId: academicYear.id });
}
