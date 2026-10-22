// Test fixtures, built with the real services so they follow the same rules as production data.
// Every helper makes uniquely named records, so tests don't depend on each other or on run order.
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../src/app';
import { Gender } from '../src/generated/prisma/client';
import { prisma } from '../src/lib/prisma';
import { createClassSection } from '../src/services/class-section.service';
import { enrollStudentInClass } from '../src/services/enrollment.service';
import { createStaff } from '../src/services/staff.service';
import { createStudent } from '../src/services/student.service';
import { createTeachingAssignment } from '../src/services/teacher-assignment.service';
import { createLogin } from '../src/services/user.service';
import { assertTestDatabase } from './setup/global-setup';

// Second guard (the first is in global setup): never run against a non-test database
assertTestDatabase(process.env.DATABASE_URL);

export { prisma };
export const api = request(app);
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const PASSWORD = 'Test@12345';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // cheap rounds: tests log in a lot

let counter = 0;
// Differs per test file. The time alone isn't enough: files that fake the clock (attendance, leave) all
// share one frozen Date.now(), and each file's counter starts at 0, so their ids would collide.
const FILE_KEY = Math.random().toString(36).slice(2, 6);
/** Short unique id, e.g. for section names and document numbers */
export const uid = () => `${Date.now().toString(36).slice(-5)}${FILE_KEY}${(counter++).toString(36)}`.toUpperCase();

export type RoleName = 'System Admin' | 'Principal' | 'Registrar' | 'Teacher' | 'Student';

export const yearNamed = (name: string) => prisma.academicYear.findUniqueOrThrow({ where: { name } });
export const subjectCode = (code: string) => prisma.subject.findUniqueOrThrow({ where: { code } });

export async function makeClass(gradeNumber: number, { year = '2026-2027', capacity = 40, homeroomTeacherId }: { year?: string; capacity?: number; homeroomTeacherId?: string } = {}) {
  const [grade, academicYear] = await Promise.all([prisma.grade.findUniqueOrThrow({ where: { gradeNumber } }), yearNamed(year)]);
  return createClassSection({ sectionName: uid().slice(-6), maxCapacity: capacity, gradeId: grade.id, academicYearId: academicYear.id, homeroomTeacherId });
}

export function makeStudent({ gender = Gender.F, dateOfBirth = new Date('2013-05-01') }: { gender?: Gender; dateOfBirth?: Date } = {}) {
  const id = uid();
  return createStudent({ birthCertificateNo: `BC${id}`, khmerName: 'សិស្ស សាកល្បង', latinName: `Student ${id}`, dateOfBirth, gender });
}

/** Students enrolled (as new admissions) in the class */
export async function makeStudentsIn(classSection: { id: string; academicYearId: string }, count: number) {
  const students = [];
  for (let i = 0; i < count; i++) {
    const s = await makeStudent();
    await enrollStudentInClass(s.id, classSection.id, classSection.academicYearId);
    students.push(s);
  }
  return students;
}

export function makeStaff() {
  const id = uid();
  return createStaff({ nationalIdNo: `ID${id}`, khmerName: 'គ្រូ សាកល្បង', latinName: `Staff ${id}`, gender: Gender.M, hireDate: new Date('2020-01-01') });
}

/** A login for the profile with one role, ready to use (known password, no forced change) */
export async function makeLogin(role: RoleName, profile: { staffId: string } | { studentId: string }) {
  const username = `t.${uid().toLowerCase()}`;
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { latinName: role } });
  const { user } = await createLogin({ ...profile, username, roleIds: [roleRow.id] } as Parameters<typeof createLogin>[0]);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: PASSWORD_HASH, mustChangePassword: false } });
  return { userId: user.id, username };
}

export async function tokenFor(username: string, password = PASSWORD) {
  const res = await api.post('/api/v1/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`Login as ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

/** A staff member with a login in the role, signed in */
export async function staffUser(role: Exclude<RoleName, 'Student'>) {
  const staff = await makeStaff();
  const login = await makeLogin(role, { staffId: staff.id });
  return { staff, ...login, token: await tokenFor(login.username) };
}

export const assignTeacher = (staffId: string, subjectId: string, classSectionId: string) =>
  createTeachingAssignment({ staffId, subjectId, classSectionId });

/** An assessment period in 2026-2027 with each subject scored directly out of maxTotalScore, set up through the API */
export async function makePeriod(principalToken: string, rules: { subjectId: string; maxTotalScore: number; components?: { name: string; maxScore: number }[] }[]) {
  const year = await yearNamed('2026-2027');
  const res = await api
    .post('/api/v1/assessment-periods')
    .set(bearer(principalToken))
    .send({ academicYearId: year.id, name: `Month ${uid()}`, startDate: '2026-12-01', endDate: '2026-12-31' });
  if (res.status !== 201) throw new Error(`Creating the period failed: ${JSON.stringify(res.body)}`);
  const period = res.body.data;
  for (const r of rules) {
    const set = await api
      .put(`/api/v1/assessment-periods/${period.id}/subjects/${r.subjectId}`)
      .set(bearer(principalToken))
      .send({ maxTotalScore: r.maxTotalScore, components: r.components });
    if (set.status !== 200) throw new Error(`Setting rules failed: ${JSON.stringify(set.body)}`);
  }
  return period as { id: string; name: string };
}
