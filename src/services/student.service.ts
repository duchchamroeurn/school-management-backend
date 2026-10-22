import { randomUUID } from 'node:crypto';
import { Errors } from '../constants/errors';
import { STUDENT_AGE_RANGE } from '../constants/school-levels';
import { Gender, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getObject } from '../lib/storage';
import { audit, scalars } from './audit.service';
import { deleteObjects, prepareDocument, preparePhoto, Upload, uploadFile, withUploads } from './file.service';
import { studentGuardiansInclude } from './guardian.service';
import { assertVillagesExist, formatAddress, villageWithParents } from './location.service';
import { getSchoolLevel } from './school-settings.service';

// What the registry (សៀវភៅបញ្ជីឈ្មោះសិស្ស) records about a student, besides the documents
export interface StudentDetailsInput {
  birthCertificateNo: string; // already normalised by the controller
  khmerName: string;
  latinName: string;
  dateOfBirth: Date;
  gender: Gender;
  primarySchoolOrigin?: string | null;
  fatherName?: string | null;
  fatherOccupation?: string | null;
  isFatherDeceased?: boolean;
  motherName?: string | null;
  motherOccupation?: string | null;
  isMotherDeceased?: boolean;
  birthPlaceVillageCode: string; // gazetteer village codes
  addressVillageCode: string;
  addressHouseNo?: string | null;
  addressStreet?: string | null;
}

// Registering a student requires the 4x4 photo and the birth certificate scan
export interface CreateStudentInput extends StudentDetailsInput {
  photo: Upload;
  birthCertificateScan: Upload;
}

// studentIdentifier is permanent and never updatable; documents are replaced with replaceStudentFile
export interface UpdateStudentInput extends Partial<StudentDetailsInput> {
  status?: StudentStatus;
}

export interface ListStudentsFilter {
  search?: string; // matches Khmer name, Latin name, student ID or birth certificate number
  status?: StudentStatus;
  gender?: Gender;
  skip: number;
  take: number;
}

// The student's documents: the field names used in requests and responses, and how each is stored
export const STUDENT_FILES = {
  photo: { relation: 'photo', objectName: 'photo', action: 'STUDENT_PHOTO_REPLACED', downloadName: 'photo' },
  birthCertificateScan: {
    relation: 'birthCertificateFile',
    objectName: 'birth-certificate',
    action: 'STUDENT_BIRTH_CERTIFICATE_REPLACED',
    downloadName: 'birth-certificate',
  },
} as const;
export type StudentFileKind = keyof typeof STUDENT_FILES;

const prepare = (kind: StudentFileKind, upload: Upload) => (kind === 'photo' ? preparePhoto(upload, kind) : prepareDocument(upload, kind));

const fileSummary = { select: { id: true, contentType: true, size: true, createdAt: true } } as const;

const summary = {
  user: { select: { id: true, username: true, status: true } },
  _count: { select: { enrollments: true } },
  birthPlaceVillage: villageWithParents,
  addressVillage: villageWithParents,
  photo: fileSummary,
  birthCertificateFile: fileSummary,
} as const satisfies Prisma.StudentProfileInclude;

type StudentRow = Prisma.StudentProfileGetPayload<{ include: typeof summary }>;

// Addresses formatted for the registry, documents as download links (the storage keys stay internal)
function present<T extends StudentRow>(student: T) {
  const { birthPlaceVillage, addressVillage, photo, birthCertificateFile, photoFileId: _p, birthCertificateFileId: _b, ...rest } = student;
  const link = (file: typeof photo, kind: StudentFileKind) => ({ ...file, url: `/api/v1/students/${student.id}/${kind === 'photo' ? 'photo' : 'birth-certificate-scan'}` });
  return {
    ...rest,
    birthPlace: formatAddress(birthPlaceVillage),
    address: formatAddress(addressVillage, { houseNo: student.addressHouseNo, street: student.addressStreet }),
    photo: link(photo, 'photo'),
    birthCertificateScan: link(birthCertificateFile, 'birthCertificateScan'),
  };
}

const auditStudent = (s: { id: string; studentIdentifier: string; latinName: string }) =>
  ({ entityType: 'Student', entityId: s.id, entityLabel: `${s.studentIdentifier} ${s.latinName}` }) as const;

const auditFile = (file: { id: string; size: number; sha256: string; contentType: string }) => ({
  fileId: file.id,
  contentType: file.contentType,
  size: file.size,
  sha256: file.sha256,
});

const duplicateStudent = (existing: { id: string; studentIdentifier: string; khmerName: string; latinName: string; birthCertificateNo: string }) =>
  Errors.DUPLICATE_STUDENT(existing);

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

// Age range depends on the school level (e.g. lower secondary 10–20, upper secondary 13–25)
async function assertPlausibleBirthDate(dateOfBirth: Date) {
  const { min, max } = STUDENT_AGE_RANGE[await getSchoolLevel()];
  const now = new Date();
  const ageAt = (years: number) => new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  if (dateOfBirth > ageAt(min) || dateOfBirth < ageAt(max)) {
    throw Errors.AGE_OUT_OF_RANGE(min, max);
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
  return { items: items.map(present), total };
}

export async function getStudent(id: string) {
  const student = await prisma.studentProfile.findUnique({
    where: { id },
    include: {
      ...summary,
      guardians: studentGuardiansInclude,
      enrollments: {
        include: {
          academicYear: { select: { id: true, name: true, status: true } },
          classSection: {
            select: {
              id: true,
              sectionName: true,
              grade: { select: { id: true, gradeNumber: true } },
              homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
            },
          },
        },
        orderBy: { academicYear: { startDate: 'desc' } },
      },
    },
  });
  if (!student) throw Errors.STUDENT_NOT_FOUND();
  return present(student);
}

// Arbitrary constant identifying the "student ID generation" lock
const STUDENT_ID_LOCK = 7_260_001;

export async function createStudent(data: CreateStudentInput) {
  const { photo, birthCertificateScan, ...details } = data;
  await assertPlausibleBirthDate(details.dateOfBirth);
  await assertCertificateFree(details.birthCertificateNo);
  await assertVillagesExist({ birthPlaceVillageCode: details.birthPlaceVillageCode, addressVillageCode: details.addressVillageCode });
  // Check and normalise both documents before storing either
  const [photoFile, scanFile] = await Promise.all([prepare('photo', photo), prepare('birthCertificateScan', birthCertificateScan)]);

  // The id is chosen here so the files can be stored under the student's folder before the row exists
  const id = randomUUID();
  const folder = `students/${id}`;
  const created = await withUploads(
    [() => uploadFile(folder, STUDENT_FILES.photo.objectName, photoFile), () => uploadFile(folder, STUDENT_FILES.birthCertificateScan.objectName, scanFile)],
    ([storedPhoto, storedScan]) =>
      guardDuplicate(details.birthCertificateNo, () =>
        prisma.$transaction(async (tx) => {
          // Serialise ID generation so simultaneous registrations can't compute the same next number.
          // The lock is released automatically when the transaction ends.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STUDENT_ID_LOCK})`;
          await tx.storedFile.createMany({ data: [storedPhoto.record, storedScan.record] });
          const student = await tx.studentProfile.create({
            data: { ...details, id, studentIdentifier: await nextStudentIdentifier(tx), photoFileId: storedPhoto.id, birthCertificateFileId: storedScan.id },
            include: summary,
          });
          await audit(tx, { ...auditStudent(student), action: 'STUDENT_CREATED', after: scalars(student, ['user']) });
          return student;
        }),
      ),
  );
  return present(created);
}

export async function updateStudent(id: string, data: UpdateStudentInput) {
  const current = await prisma.studentProfile.findUnique({ where: { id } });
  if (!current) throw Errors.STUDENT_NOT_FOUND();
  if (data.dateOfBirth) await assertPlausibleBirthDate(data.dateOfBirth);
  if (data.birthCertificateNo) await assertCertificateFree(data.birthCertificateNo, id);
  await assertVillagesExist({ birthPlaceVillageCode: data.birthPlaceVillageCode, addressVillageCode: data.addressVillageCode });

  const updated = await guardDuplicate(data.birthCertificateNo, () =>
    prisma.$transaction(async (tx) => {
      const updated = await tx.studentProfile.update({ where: { id }, data, include: summary });
      await audit(tx, { ...auditStudent(updated), action: 'STUDENT_UPDATED', before: scalars(current, ['user']), after: scalars(updated, ['user']) });
      return updated;
    }),
  );
  return present(updated);
}

/** Replaces the student's photo or birth certificate scan; the old file is removed */
export async function replaceStudentFile(id: string, kind: StudentFileKind, upload: Upload) {
  if (!(await prisma.studentProfile.findUnique({ where: { id }, select: { id: true } }))) throw Errors.STUDENT_NOT_FOUND();
  const file = await prepare(kind, upload);
  const { relation, objectName, action } = STUDENT_FILES[kind];

  const { student, oldObjectKey } = await withUploads([() => uploadFile(`students/${id}`, objectName, file)], ([stored]) =>
    prisma.$transaction(async (tx) => {
      // Lock the student so two replacements at once can't both remove the same old file
      await tx.$queryRaw`SELECT id FROM student_profiles WHERE id = ${id} FOR UPDATE`;
      const before = await tx.studentProfile.findUnique({ where: { id }, include: { photo: true, birthCertificateFile: true } });
      if (!before) throw Errors.STUDENT_NOT_FOUND();
      const old = before[relation];

      const created = await tx.storedFile.create({ data: stored.record });
      const student = await tx.studentProfile.update({
        where: { id },
        data: kind === 'photo' ? { photoFileId: created.id } : { birthCertificateFileId: created.id },
        include: summary,
      });
      await tx.storedFile.delete({ where: { id: old.id } });
      await audit(tx, { ...auditStudent(student), action, before: auditFile(old), after: auditFile(created) });
      return { student, oldObjectKey: old.objectKey };
    }),
  );
  await deleteObjects([oldObjectKey]);
  return present(student);
}

/** The stored photo or scan, to stream to the client */
export async function getStudentFile(id: string, kind: StudentFileKind) {
  const { relation, downloadName } = STUDENT_FILES[kind];
  const student = await prisma.studentProfile.findUnique({
    where: { id },
    select: { studentIdentifier: true, photo: true, birthCertificateFile: true },
  });
  if (!student) throw Errors.STUDENT_NOT_FOUND();
  const file = student[relation];
  const extension = file.objectKey.split('.').pop();
  return {
    contentType: file.contentType,
    size: file.size,
    etag: `"${file.sha256}"`,
    filename: `${student.studentIdentifier}-${downloadName}.${extension}`,
    open: () => getObject(file.objectKey),
  };
}

// Only for records created by mistake. Real students leave via status DROPPED_OUT / GRADUATED,
// so their history is kept.
export async function deleteStudent(id: string) {
  const student = await prisma.studentProfile.findUnique({
    where: { id },
    include: { ...summary, photo: true, birthCertificateFile: true },
  });
  if (!student) throw Errors.STUDENT_NOT_FOUND();
  if (student._count.enrollments > 0) {
    throw Errors.STUDENT_HAS_HISTORY(student.studentIdentifier, student._count.enrollments);
  }
  if (student.user) {
    throw Errors.STUDENT_HAS_LOGIN(student.studentIdentifier);
  }
  const files = [student.photo, student.birthCertificateFile];
  await prisma.$transaction(async (tx) => {
    await tx.studentProfile.delete({ where: { id } });
    await tx.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
    await audit(tx, { ...auditStudent(student), action: 'STUDENT_DELETED', before: scalars(student, ['user']) });
  });
  await deleteObjects(files.map((f) => f.objectKey));
}
