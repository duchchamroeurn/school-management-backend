// Self-service views for the signed-in user. The profile is always found from the login itself,
// never from an id in the request, so a user can only ever see their own records.
import { Errors } from '../constants/errors';
import { AcademicYearStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getClassRoster } from './enrollment.service';
import { getStaff } from './staff.service';
import { getStudent } from './student.service';

// Own student record with enrollment history, or own staff record with homeroom history
export async function getOwnProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { studentProfile: { select: { id: true } }, staffProfile: { select: { id: true } } },
  });
  if (user.studentProfile) {
    return { profileType: 'STUDENT' as const, profile: await getStudent(user.studentProfile.id) };
  }
  if (user.staffProfile) {
    return { profileType: 'STAFF' as const, profile: await getStaff(user.staffProfile.id) };
  }
  throw Errors.OWN_PROFILE_NOT_FOUND();
}

// Roster of the class the signed-in teacher is homeroom teacher of, in the given or the ACTIVE academic year
export async function getOwnHomeroom(userId: string, academicYearName?: string) {
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

  // At most one per teacher per year (unique constraint)
  const classSection = await prisma.classSection.findFirst({
    where: { homeroomTeacherId: staff.id, academicYearId: academicYear.id },
    select: { id: true },
  });
  if (!classSection) throw Errors.NO_HOMEROOM_CLASS(academicYear.name);
  return getClassRoster(classSection.id);
}
