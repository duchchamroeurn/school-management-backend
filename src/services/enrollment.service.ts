import { AcademicYearStatus, EnrollmentType, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';

const details = {
  student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, gender: true, status: true } },
  classSection: { select: { id: true, sectionName: true, maxCapacity: true, grade: { select: { id: true, gradeNumber: true } } } },
  academicYear: { select: { id: true, name: true, status: true } },
} as const;

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

const notFound = () => new HttpError(404, 'ENROLLMENT_NOT_FOUND', 'Enrollment not found');

const yearClosed = (name: string) =>
  new HttpError(409, 'ACADEMIC_YEAR_CLOSED', `Academic year ${name} is completed; its enrollments can no longer be changed`);

/**
 * Locks the class section row until the surrounding transaction ends, then loads it.
 * Concurrent enrollments/transfers into the same class wait here and then see the updated count,
 * so a class can never be overfilled.
 */
async function lockClassSection(tx: Prisma.TransactionClient, classSectionId: string) {
  const [locked] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM class_sections WHERE id = ${classSectionId} FOR UPDATE`;
  if (!locked) throw new HttpError(404, 'CLASS_SECTION_NOT_FOUND', 'Class section not found');

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
    throw new HttpError(400, 'CLASS_CAPACITY_REACHED', 'Class capacity reached.', {
      maxCapacity: classSection.maxCapacity,
      currentEnrollment: current,
    });
  }
}

const alreadyEnrolled = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    ? new HttpError(409, 'ALREADY_ENROLLED', 'Student is already enrolled in this academic year')
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
        throw new HttpError(
          400,
          'ACADEMIC_YEAR_MISMATCH',
          `Class ${classSection.grade.gradeNumber}${classSection.sectionName} belongs to academic year ${classSection.academicYear.name}, not the one requested`,
        );
      }

      const student = await tx.studentProfile.findUnique({
        where: { id: studentId },
        include: { enrollments: { include: { academicYear: true } } },
      });
      if (!student) throw new HttpError(404, 'STUDENT_NOT_FOUND', 'Student not found');
      if (student.status !== StudentStatus.ENROLLED) {
        throw new HttpError(409, 'STUDENT_NOT_ACTIVE', `Student ${student.studentIdentifier} is ${student.status} and cannot be enrolled`);
      }

      const sameYear = student.enrollments.find((e) => e.academicYearId === academicYearId);
      if (sameYear) {
        throw new HttpError(409, 'ALREADY_ENROLLED', `Student ${student.studentIdentifier} is already enrolled in academic year ${sameYear.academicYear.name}`);
      }
      if (student.enrollments.length > 0) {
        throw new HttpError(
          409,
          'NOT_A_NEW_ADMISSION',
          `Student ${student.studentIdentifier} has previous enrollments; use promotion or repeating instead of NEW_ADMISSION`,
        );
      }

      await assertSeatAvailable(tx, classSection);

      return tx.yearlyEnrollment.create({
        data: { studentId, classSectionId, academicYearId, enrollmentType: EnrollmentType.NEW_ADMISSION },
        include: details,
      });
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
        throw new HttpError(400, 'ACADEMIC_YEAR_MISMATCH', `Class ${classSection.grade.gradeNumber}${classSection.sectionName} belongs to academic year ${classSection.academicYear.name}`);
      }

      const student = await tx.studentProfile.findUnique({
        where: { id: studentId },
        include: { enrollments: { include: { academicYear: true } } },
      });
      if (!student) throw new HttpError(404, 'STUDENT_NOT_FOUND', 'Student not found');
      if (student.status !== StudentStatus.ENROLLED) {
        throw new HttpError(409, 'STUDENT_NOT_ACTIVE', `Student ${student.studentIdentifier} is ${student.status} and cannot be enrolled`);
      }
      if (student.enrollments.some((e) => e.academicYearId === academicYearId)) {
        throw new HttpError(409, 'ALREADY_ENROLLED', `Student ${student.studentIdentifier} is already enrolled in ${classSection.academicYear.name}`);
      }
      if (!student.enrollments.some((e) => e.academicYear.startDate < classSection.academicYear.startDate)) {
        throw new HttpError(409, 'NO_PREVIOUS_ENROLLMENT', `Student ${student.studentIdentifier} has no earlier enrollment; use NEW_ADMISSION`);
      }

      await assertSeatAvailable(tx, classSection);
      return tx.yearlyEnrollment.create({
        data: { studentId, classSectionId, academicYearId, enrollmentType },
        include: details,
      });
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
  if (!enrollment) throw notFound();
  return enrollment;
}

/**
 * Moves a student to another class section in the same academic year (e.g. 7A → 7B).
 * The target class is locked and its capacity checked exactly like a new enrollment.
 */
export async function transferEnrollment(id: string, targetClassSectionId: string) {
  return prisma.$transaction(async (tx) => {
    const enrollment = await tx.yearlyEnrollment.findUnique({ where: { id }, include: { academicYear: true, student: true } });
    if (!enrollment) throw notFound();
    if (enrollment.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(enrollment.academicYear.name);
    if (enrollment.classSectionId === targetClassSectionId) {
      throw new HttpError(400, 'SAME_CLASS_SECTION', 'Student is already in this class section');
    }

    const target = await lockClassSection(tx, targetClassSectionId);
    if (target.academicYearId !== enrollment.academicYearId) {
      throw new HttpError(
        400,
        'ACADEMIC_YEAR_MISMATCH',
        `Transfers must stay within ${enrollment.academicYear.name}; class ${target.grade.gradeNumber}${target.sectionName} is in ${target.academicYear.name}`,
      );
    }
    // A dropped-out/graduated student doesn't occupy a seat, so moving their record doesn't need one
    if (enrollment.student.status === StudentStatus.ENROLLED) await assertSeatAvailable(tx, target);

    return tx.yearlyEnrollment.update({ where: { id }, data: { classSectionId: target.id }, include: details });
  });
}

// For enrollments made by mistake. Students who leave keep their enrollment and get status DROPPED_OUT.
export async function deleteEnrollment(id: string) {
  const enrollment = await prisma.yearlyEnrollment.findUnique({ where: { id }, include: { academicYear: true } });
  if (!enrollment) throw notFound();
  if (enrollment.academicYear.status === AcademicYearStatus.COMPLETED) throw yearClosed(enrollment.academicYear.name);
  await prisma.yearlyEnrollment.delete({ where: { id } });
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
  if (!classSection) throw new HttpError(404, 'CLASS_SECTION_NOT_FOUND', 'Class section not found');

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
