import { Gender, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';

export interface CreateStudentInput {
  birthCertificateNo: string; // already normalised by the controller
  khmerName: string;
  latinName: string;
  dateOfBirth: Date;
  gender: Gender;
  primarySchoolOrigin?: string | null;
}

// studentIdentifier is permanent and never updatable
export interface UpdateStudentInput extends Partial<CreateStudentInput> {
  status?: StudentStatus;
}

export interface ListStudentsFilter {
  search?: string; // matches Khmer name, Latin name, student ID or birth certificate number
  status?: StudentStatus;
  gender?: Gender;
  skip: number;
  take: number;
}

// Secondary-school age sanity range
const MIN_AGE = 8;
const MAX_AGE = 30;

const summary = {
  user: { select: { id: true, username: true, status: true } },
  _count: { select: { enrollments: true } },
} as const;

const notFound = () => new HttpError(404, 'STUDENT_NOT_FOUND', 'Student not found');

const duplicateStudent = (existing: { id: string; studentIdentifier: string; khmerName: string; latinName: string; birthCertificateNo: string }) =>
  new HttpError(
    409,
    'DUPLICATE_STUDENT',
    `Birth certificate ${existing.birthCertificateNo} is already registered to ${existing.studentIdentifier} ${existing.khmerName} (${existing.latinName})`,
    { existingStudentId: existing.id, studentIdentifier: existing.studentIdentifier },
  );

async function assertCertificateFree(birthCertificateNo: string, excludeId?: string) {
  const existing = await prisma.studentProfile.findUnique({ where: { birthCertificateNo } });
  if (existing && existing.id !== excludeId) throw duplicateStudent(existing);
}

// Two registrations of the same certificate at the same moment can both pass the check above;
// the DB unique constraint rejects one — report it the same way.
async function guardDuplicate<T>(birthCertificateNo: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (birthCertificateNo && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.studentProfile.findUnique({ where: { birthCertificateNo } });
      if (existing) throw duplicateStudent(existing);
    }
    throw err;
  }
}

function assertPlausibleBirthDate(dateOfBirth: Date) {
  const now = new Date();
  const ageAt = (years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  if (dateOfBirth > ageAt(MIN_AGE) || dateOfBirth < ageAt(MAX_AGE)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `dateOfBirth must give an age between ${MIN_AGE} and ${MAX_AGE}`, {
      field: 'dateOfBirth',
    });
  }
}

// STU-<YY>-<0001>: admission year + running number within that year
async function nextStudentIdentifier(tx: Prisma.TransactionClient) {
  const prefix = `STU-${String(new Date().getUTCFullYear()).slice(-2)}-`;
  const last = await tx.studentProfile.findFirst({
    where: { studentIdentifier: { startsWith: prefix } },
    orderBy: { studentIdentifier: 'desc' },
    select: { studentIdentifier: true },
  });
  const next = last ? Number(last.studentIdentifier.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export async function listStudents(filter: ListStudentsFilter) {
  const where: Prisma.StudentProfileWhereInput = {
    status: filter.status,
    gender: filter.gender,
    ...(filter.search && {
      OR: [
        { khmerName: { contains: filter.search } },
        { latinName: { contains: filter.search, mode: 'insensitive' } },
        { studentIdentifier: { contains: filter.search, mode: 'insensitive' } },
        { birthCertificateNo: { contains: filter.search, mode: 'insensitive' } },
      ],
    }),
  };

  const [items, total] = await prisma.$transaction([
    prisma.studentProfile.findMany({
      where,
      include: summary,
      orderBy: { studentIdentifier: 'desc' },
      skip: filter.skip,
      take: filter.take,
    }),
    prisma.studentProfile.count({ where }),
  ]);
  return { items, total };
}

export async function getStudent(id: string) {
  const student = await prisma.studentProfile.findUnique({
    where: { id },
    include: {
      ...summary,
      enrollments: {
        include: {
          academicYear: { select: { id: true, name: true, status: true } },
          classSection: { select: { id: true, sectionName: true, grade: { select: { id: true, gradeNumber: true } } } },
        },
        orderBy: { academicYear: { startDate: 'desc' } },
      },
    },
  });
  if (!student) throw notFound();
  return student;
}

// Arbitrary constant identifying the "student ID generation" lock
const STUDENT_ID_LOCK = 7_260_001;

export async function createStudent(data: CreateStudentInput) {
  assertPlausibleBirthDate(data.dateOfBirth);
  await assertCertificateFree(data.birthCertificateNo);

  return guardDuplicate(data.birthCertificateNo, () =>
    prisma.$transaction(async (tx) => {
      // Serialise ID generation so simultaneous registrations can't compute the same next number.
      // The lock is released automatically when the transaction ends.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STUDENT_ID_LOCK})`;
      return tx.studentProfile.create({
        data: { ...data, studentIdentifier: await nextStudentIdentifier(tx) },
        include: summary,
      });
    }),
  );
}

export async function updateStudent(id: string, data: UpdateStudentInput) {
  if (!(await prisma.studentProfile.findUnique({ where: { id } }))) throw notFound();
  if (data.dateOfBirth) assertPlausibleBirthDate(data.dateOfBirth);
  if (data.birthCertificateNo) await assertCertificateFree(data.birthCertificateNo, id);

  return guardDuplicate(data.birthCertificateNo, () =>
    prisma.studentProfile.update({ where: { id }, data, include: summary }),
  );
}

// Only for records created by mistake. Real students leave via status DROPPED_OUT / GRADUATED,
// so their history is kept.
export async function deleteStudent(id: string) {
  const student = await prisma.studentProfile.findUnique({ where: { id }, include: summary });
  if (!student) throw notFound();
  if (student._count.enrollments > 0) {
    throw new HttpError(
      409,
      'STUDENT_HAS_HISTORY',
      `Student ${student.studentIdentifier} has ${student._count.enrollments} enrollment(s). Set status to DROPPED_OUT or GRADUATED instead of deleting.`,
    );
  }
  if (student.user) {
    throw new HttpError(409, 'STUDENT_HAS_LOGIN', `Student ${student.studentIdentifier} has a login account; remove it first`);
  }
  await prisma.studentProfile.delete({ where: { id } });
}
