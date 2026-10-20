import { Errors } from '../constants/errors';
import { AcademicYearStatus, Gender, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { assertTeacherFreeForYear, classSectionDetails, guardUnique } from './class-section.service';

export interface StaffInput {
  nationalIdNo: string; // already normalised by the controller
  khmerName: string;
  latinName: string;
  gender: Gender;
  phone?: string | null;
  telegramHandle?: string | null;
  hireDate: Date;
}

export interface ListStaffFilter {
  search?: string; // Khmer name, Latin name, national ID, phone or Telegram handle
  gender?: Gender;
  skip: number;
  take: number;
}

export interface AssignHomeroomInput {
  staffId: string;
  classSectionId: string; // the homeroom class
  academicYearName?: string; // e.g. "2026-2027"; defaults to the ACTIVE year
}

const summary = {
  user: { select: { id: true, username: true, status: true } },
  _count: { select: { homeroomClasses: true } },
} as const;


const duplicateStaff = (existing: { id: string; nationalIdNo: string; khmerName: string; latinName: string }) =>
  Errors.DUPLICATE_STAFF(existing);

async function assertNationalIdFree(nationalIdNo: string, excludeId?: string) {
  const existing = await prisma.staffProfile.findUnique({ where: { nationalIdNo } });
  if (existing && existing.id !== excludeId) throw duplicateStaff(existing);
}

// Two requests with the same national ID at the same moment can both pass the check above;
// the DB unique constraint rejects one — report it the same way.
async function guardDuplicate<T>(nationalIdNo: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (nationalIdNo && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.staffProfile.findUnique({ where: { nationalIdNo } });
      if (existing) throw duplicateStaff(existing);
    }
    throw err;
  }
}

function assertHireDateNotInFuture(hireDate: Date) {
  if (hireDate > new Date()) {
    throw Errors.HIRE_DATE_IN_FUTURE();
  }
}

export async function listStaff(filter: ListStaffFilter) {
  const where: Prisma.StaffProfileWhereInput = {
    gender: filter.gender,
    ...(filter.search && {
      OR: [
        { khmerName: { contains: filter.search } },
        { latinName: { contains: filter.search, mode: 'insensitive' } },
        { nationalIdNo: { contains: filter.search.replace(/\s+/g, ''), mode: 'insensitive' } },
        { phone: { contains: filter.search.replace(/[\s\-]/g, '') } },
        { telegramHandle: { contains: filter.search.replace(/^@/, ''), mode: 'insensitive' } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.staffProfile.findMany({ where, include: summary, orderBy: { khmerName: 'asc' }, skip: filter.skip, take: filter.take }),
    prisma.staffProfile.count({ where }),
  ]);
  return { items, total };
}

export async function getStaff(id: string) {
  const staff = await prisma.staffProfile.findUnique({
    where: { id },
    include: {
      ...summary,
      homeroomClasses: {
        select: { id: true, sectionName: true, grade: { select: { gradeNumber: true } }, academicYear: { select: { id: true, name: true, status: true } } },
        orderBy: { academicYear: { startDate: 'desc' } },
      },
    },
  });
  if (!staff) throw Errors.STAFF_NOT_FOUND();
  return staff;
}

export async function createStaff(data: StaffInput) {
  assertHireDateNotInFuture(data.hireDate);
  await assertNationalIdFree(data.nationalIdNo);
  return guardDuplicate(data.nationalIdNo, () => prisma.staffProfile.create({ data, include: summary }));
}

export async function updateStaff(id: string, data: Partial<StaffInput>) {
  if (!(await prisma.staffProfile.findUnique({ where: { id } }))) throw Errors.STAFF_NOT_FOUND();
  if (data.hireDate) assertHireDateNotInFuture(data.hireDate);
  if (data.nationalIdNo) await assertNationalIdFree(data.nationalIdNo, id);
  return guardDuplicate(data.nationalIdNo, () => prisma.staffProfile.update({ where: { id }, data, include: summary }));
}

// Staff who were ever a homeroom teacher keep their record (class history); same for staff with a login.
export async function deleteStaff(id: string) {
  const staff = await prisma.staffProfile.findUnique({ where: { id }, include: summary });
  if (!staff) throw Errors.STAFF_NOT_FOUND();
  if (staff._count.homeroomClasses > 0) {
    throw Errors.STAFF_HAS_HOMEROOM(staff.latinName, staff._count.homeroomClasses);
  }
  if (staff.user) {
    throw Errors.STAFF_HAS_LOGIN(staff.latinName);
  }
  await prisma.staffProfile.delete({ where: { id } });
}

/**
 * Makes a staff member the homeroom teacher of a class section.
 * - The class must belong to the given academic year (or the ACTIVE year when none is given).
 * - A teacher can be homeroom teacher of only one class per year.
 * - If the class already has a different homeroom teacher, they are replaced (returned as previousHomeroomTeacher).
 */
export async function assignHomeroom({ staffId, classSectionId, academicYearName }: AssignHomeroomInput) {
  const [staff, classSection, academicYear] = await Promise.all([
    prisma.staffProfile.findUnique({ where: { id: staffId } }),
    prisma.classSection.findUnique({ where: { id: classSectionId }, include: { grade: true, homeroomTeacher: true } }),
    academicYearName
      ? prisma.academicYear.findUnique({ where: { name: academicYearName } })
      : prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } }),
  ]);

  if (!staff) throw Errors.STAFF_NOT_FOUND();
  if (!classSection) throw Errors.HOMEROOM_CLASS_NOT_FOUND();
  if (!academicYear) {
    throw academicYearName
      ? Errors.ACADEMIC_YEAR_NOT_FOUND(academicYearName)
      : Errors.ACADEMIC_YEAR_REQUIRED();
  }

  const className = `${classSection.grade.gradeNumber}${classSection.sectionName}`;
  if (classSection.academicYearId !== academicYear.id) {
    throw Errors.CLASS_NOT_IN_YEAR(className, academicYear.name);
  }
  if (academicYear.status === AcademicYearStatus.COMPLETED) {
    throw Errors.ACADEMIC_YEAR_CLOSED(academicYear.name, 'homeroom teachers');
  }

  const previous = classSection.homeroomTeacher;
  if (previous?.id === staff.id) {
    return { classSection: await prisma.classSection.findUniqueOrThrow({ where: { id: classSectionId }, include: classSectionDetails }), previousHomeroomTeacher: null, changed: false };
  }

  const check = () => assertTeacherFreeForYear(staff.id, academicYear.id, classSection.id);
  await check();

  const updated = await guardUnique(
    () => prisma.classSection.update({ where: { id: classSectionId }, data: { homeroomTeacherId: staff.id }, include: classSectionDetails }),
    check,
  );
  return {
    classSection: updated,
    previousHomeroomTeacher: previous ? { id: previous.id, khmerName: previous.khmerName, latinName: previous.latinName } : null,
    changed: true,
  };
}
