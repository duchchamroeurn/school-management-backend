import { Errors } from '../constants/errors';
import { AcademicYearStatus, EnrollmentType, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';

const details = {
  student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, gender: true, status: true } },
  classSection: { select: { id: true, sectionName: true, maxCapacity: true, grade: { select: { id: true, gradeNumber: true } } } },
  academicYear: { select: { id: true, name: true, status: true } },
} as const;

type EnrollmentWithDetails = Prisma.YearlyEnrollmentGetPayload<{ include: typeof details }>;

// Ids plus readable names, so an entry still makes sense after the student or class is gone
const auditSnapshot = (e: EnrollmentWithDetails) => ({
  studentId: e.student.id,
  student: `${e.student.studentIdentifier} ${e.student.latinName}`,
  classSectionId: e.classSection.id,
  classSection: `${e.classSection.grade.gradeNumber}${e.classSection.sectionName}`,
  academicYear: e.academicYear.name,
  enrollmentType: e.enrollmentType,
});

const auditEnrollment = (e: EnrollmentWithDetails) =>
  ({
    entityType: 'Enrollment',
    entityId: e.id,
    entityLabel: `${e.student.studentIdentifier} ${e.student.latinName} — ${e.academicYear.name}`,
  }) as const;

async function createAudited(tx: Prisma.TransactionClient, data: Prisma.YearlyEnrollmentUncheckedCreateInput) {
  const created = await tx.yearlyEnrollment.create({ data, include: details });
  await audit(tx, { ...auditEnrollment(created), action: 'ENROLLMENT_CREATED', after: auditSnapshot(created) });
  return created;
}

export interface ListEnrollmentsFilter {
  academicYearId?: string;
  classSectionId?: string;
  studentId?: string;
  skip: number;
  take: number;
}

// A seat is taken by every enrollment in the section whose student is still ENROLLED
// (students who dropped out or graduated free their seat).
const activeEnrollmentsIn = (classSectionId: string): Prisma.YearlyEnrollmentWhereInput => ({
  classSectionId,
  student: { status: StudentStatus.ENROLLED },
});


const yearClosed = (name: string) =>
  Errors.ACADEMIC_YEAR_CLOSED(name, 'its enrollments');

/**
 * Locks the class section row until the surrounding transaction ends, then loads it.
 * Concurrent enrollments/transfers into the same class wait here and then see the updated count,
 * so a class can never be overfilled.
 */
async function lockClassSection(tx: Prisma.TransactionClient, classSectionId: string) {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM class_sections WHERE id = ${classSectionId} FOR UPDATE`;
  if (!locked) throw Errors.CLASS_SECTION_NOT_FOUND();

  const classSection = await tx.classSection.findUniqueOrThrow({
    where: { id: classSectionId },
    include: { academicYear: true, grade: true },
  });
  if (classSection.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(classSection.academicYear.name);
  return classSection;
}

// Must be called after lockClassSection in the same transaction
async function assertSeatAvailable(tx: Prisma.TransactionClient, classSection: { id: string; maxCapacity: number }) {
  const current = await tx.yearlyEnrollment.count({ where: activeEnrollmentsIn(classSection.id) });
  if (current >= classSection.maxCapacity) {
    throw Errors.CLASS_CAPACITY_REACHED(classSection.maxCapacity, current);
  }
}

const alreadyEnrolled = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    ? Errors.ALREADY_ENROLLED()
    : err;

/**
 * Places a newly admitted student into a class section for the given academic year.
 * Capacity is checked and the enrollment created inside one transaction while the class
 * section row is locked, so two simultaneous requests can never overfill a class.
 */
export async function enrollStudentInClass(studentId: string, classSectionId: string, academicYearId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      const classSection = await lockClassSection(tx, classSectionId);
      if (classSection.academicYearId !== academicYearId) {
        throw Errors.CLASS_IN_OTHER_YEAR(`${classSection.grade.gradeNumber}${classSection.sectionName}`, classSection.academicYear.name);
      }

      const student = await tx.studentProfile.findUnique({
        where: { id: studentId },
        include: { enrollments: { include: { academicYear: true } } },
      });
      if (!student) throw Errors.STUDENT_NOT_FOUND();
      if (student.status !== StudentStatus.ENROLLED) {
        throw Errors.STUDENT_NOT_ACTIVE(student.studentIdentifier, student.status);
      }

      const sameYear = student.enrollments.find((e) => e.academicYearId === academicYearId);
      if (sameYear) {
        throw Errors.ALREADY_ENROLLED(student.studentIdentifier, sameYear.academicYear.name);
      }
      if (student.enrollments.length > 0) {
        throw Errors.NOT_A_NEW_ADMISSION(student.studentIdentifier);
      }

      await assertSeatAvailable(tx, classSection);

      return createAudited(tx, { studentId, classSectionId, academicYearId, enrollmentType: EnrollmentType.NEW_ADMISSION });
    });
  } catch (err) {
    // The same student enrolled by two requests at once: the (studentId, academicYearId) unique constraint catches it
    throw alreadyEnrolled(err);
  }
}

/**
 * Enrolls a returning student (one with an enrollment in an earlier academic year) as PROMOTED or
 * REPEATING. Same capacity lock as new admissions. Not exposed via the API yet — used by the demo
 * seed and intended for the future end-of-year promotion feature.
 */
export async function enrollContinuingStudent(
  studentId: string,
  classSectionId: string,
  academicYearId: string,
  enrollmentType: typeof EnrollmentType.PROMOTED | typeof EnrollmentType.REPEATING,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const classSection = await lockClassSection(tx, classSectionId);
      if (classSection.academicYearId !== academicYearId) {
        throw Errors.CLASS_IN_OTHER_YEAR(`${classSection.grade.gradeNumber}${classSection.sectionName}`, classSection.academicYear.name);
      }

      const student = await tx.studentProfile.findUnique({
        where: { id: studentId },
        include: { enrollments: { include: { academicYear: true } } },
      });
      if (!student) throw Errors.STUDENT_NOT_FOUND();
      if (student.status !== StudentStatus.ENROLLED) {
        throw Errors.STUDENT_NOT_ACTIVE(student.studentIdentifier, student.status);
      }
      if (student.enrollments.some((e) => e.academicYearId === academicYearId)) {
        throw Errors.ALREADY_ENROLLED(student.studentIdentifier, classSection.academicYear.name);
      }
      if (!student.enrollments.some((e) => e.academicYear.startDate < classSection.academicYear.startDate)) {
        throw Errors.NO_PREVIOUS_ENROLLMENT(student.studentIdentifier);
      }

      await assertSeatAvailable(tx, classSection);
      return createAudited(tx, { studentId, classSectionId, academicYearId, enrollmentType });
    });
  } catch (err) {
    throw alreadyEnrolled(err);
  }
}

export async function listEnrollments(filter: ListEnrollmentsFilter) {
  const where: Prisma.YearlyEnrollmentWhereInput = {
    academicYearId: filter.academicYearId,
    classSectionId: filter.classSectionId,
    studentId: filter.studentId,
  };
  const [items, total] = await prisma.$transaction([
    prisma.yearlyEnrollment.findMany({
      where,
      include: details,
      orderBy: [
        { academicYear: { startDate: 'desc' } },
        { classSection: { grade: { gradeNumber: 'asc' } } },
        { classSection: { sectionName: 'asc' } },
        { student: { khmerName: 'asc' } },
      ],
      skip: filter.skip,
      take: filter.take,
    }),
    prisma.yearlyEnrollment.count({ where }),
  ]);
  return { items, total };
}

export async function getEnrollment(id: string) {
  const enrollment = await prisma.yearlyEnrollment.findUnique({ where: { id }, include: details });
  if (!enrollment) throw Errors.ENROLLMENT_NOT_FOUND();
  return enrollment;
}

/**
 * Moves a student to another class section in the same academic year (e.g. 7A → 7B).
 * The target class is locked and its capacity checked exactly like a new enrollment.
 */
export async function transferEnrollment(id: string, targetClassSectionId: string) {
  return prisma.$transaction(async (tx) => {
    const enrollment = await tx.yearlyEnrollment.findUnique({ where: { id }, include: { ...details, academicYear: true, student: true } });
    if (!enrollment) throw Errors.ENROLLMENT_NOT_FOUND();
    if (enrollment.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(enrollment.academicYear.name);
    if (enrollment.classSectionId === targetClassSectionId) {
      throw Errors.SAME_CLASS_SECTION();
    }

    const target = await lockClassSection(tx, targetClassSectionId);
    if (target.academicYearId !== enrollment.academicYearId) {
      throw Errors.TRANSFER_OUTSIDE_YEAR(enrollment.academicYear.name, `${target.grade.gradeNumber}${target.sectionName}`, target.academicYear.name);
    }
    // A dropped-out/graduated student doesn't occupy a seat, so moving their record doesn't need one
    if (enrollment.student.status === StudentStatus.ENROLLED) await assertSeatAvailable(tx, target);

    const updated = await tx.yearlyEnrollment.update({ where: { id }, data: { classSectionId: target.id }, include: details });
    await audit(tx, { ...auditEnrollment(updated), action: 'ENROLLMENT_TRANSFERRED', before: auditSnapshot(enrollment), after: auditSnapshot(updated) });
    return updated;
  });
}

// For enrollments made by mistake. Students who leave keep their enrollment and get status DROPPED_OUT.
export async function deleteEnrollment(id: string) {
  const enrollment = await prisma.yearlyEnrollment.findUnique({ where: { id }, include: details });
  if (!enrollment) throw Errors.ENROLLMENT_NOT_FOUND();
  if (enrollment.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(enrollment.academicYear.name);
  await prisma.$transaction(async (tx) => {
    await tx.yearlyEnrollment.delete({ where: { id } });
    await audit(tx, { ...auditEnrollment(enrollment), action: 'ENROLLMENT_DELETED', before: auditSnapshot(enrollment) });
  });
}

// Class list (បញ្ជីឈ្មោះសិស្ស) sorted by Khmer name, with seat usage
export async function getClassRoster(classSectionId: string) {
  const classSection = await prisma.classSection.findUnique({
    where: { id: classSectionId },
    include: {
      grade: true,
      academicYear: { select: { id: true, name: true, status: true } },
      homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
      enrollments: {
        include: {
          student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, gender: true, dateOfBirth: true, status: true } },
        },
        orderBy: { student: { khmerName: 'asc' } },
      },
    },
  });
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();

  const { enrollments, ...info } = classSection;
  const active = enrollments.filter((e) => e.student.status === StudentStatus.ENROLLED);
  return {
    classSection: info,
    summary: {
      maxCapacity: info.maxCapacity,
      enrolled: active.length,
      seatsLeft: Math.max(info.maxCapacity - active.length, 0),
      female: active.filter((e) => e.student.gender === 'F').length,
      male: active.filter((e) => e.student.gender === 'M').length,
    },
    students: enrollments.map((e, index) => ({
      no: index + 1,
      enrollmentId: e.id,
      enrollmentType: e.enrollmentType,
      enrollmentDate: e.enrollmentDate,
      ...e.student,
    })),
  };
}
