// Builds a complete demo school on top of the imported students/staff so every feature can be tested.
// Everything goes through the service layer, so demo data obeys the same rules as the API.
//
//   npm run db:seed:demo                       # build the demo (once; refuses if already built)
//   npm run db:reset:demo                      # remove demo data, restore the years, rebuild (asks for --confirm)
//
// Requires: npm run db:seed (reference data), db:seed:students and db:seed:staff (≥ 100 / ≥ 24 records).
// Never runs automatically and refuses to run with NODE_ENV=production.
import { SYSTEM_ROLES } from '../constants/roles';
import { AcademicYearStatus, EnrollmentType, StudentStatus, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { createAcademicYear, updateAcademicYear } from '../services/academic-year.service';
import { createClassSection } from '../services/class-section.service';
import { enrollContinuingStudent, enrollStudentInClass } from '../services/enrollment.service';
import { assignHomeroom } from '../services/staff.service';
import { updateStudent } from '../services/student.service';
import { createLogin, setStatus } from '../services/user.service';
import { hashPassword } from './password';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';
const CAPACITY = 12;
const SECTIONS = ['A', 'B'];

const LAST_YEAR = '2025-2026';
const CURRENT_YEAR = '2026-2027';
const NEXT_YEAR = { name: '2027-2028', startDate: new Date('2027-11-01'), endDate: new Date('2028-08-31') };
const DEMO_YEARS = [LAST_YEAR, CURRENT_YEAR, NEXT_YEAR.name];
const DEMO_USERNAME_PREFIX = 'demo.';

const log = (msg: string) => console.log(`  ${msg}`);

// ==========================================
// RESET
// ==========================================

async function resetDemo() {
  console.log('Resetting demo data…');
  await prisma.$transaction(async (tx) => {
    const users = await tx.user.deleteMany({ where: { username: { startsWith: DEMO_USERNAME_PREFIX } } });
    const enrollments = await tx.yearlyEnrollment.deleteMany({ where: { academicYear: { name: { in: DEMO_YEARS } } } });
    const classes = await tx.classSection.deleteMany({ where: { academicYear: { name: { in: DEMO_YEARS } } } });
    await tx.academicYear.deleteMany({ where: { name: NEXT_YEAR.name } });
    // Restore the years as they were before the demo (only one ACTIVE at a time → demote first)
    await tx.academicYear.updateMany({ where: { name: CURRENT_YEAR }, data: { status: AcademicYearStatus.UPCOMING } });
    await tx.academicYear.updateMany({ where: { name: LAST_YEAR }, data: { status: AcademicYearStatus.ACTIVE } });
    const students = await tx.studentProfile.updateMany({ where: { status: { not: StudentStatus.ENROLLED } }, data: { status: StudentStatus.ENROLLED } });
    log(`✓ removed ${users.count} demo logins, ${enrollments.count} enrollments, ${classes.count} class sections, year ${NEXT_YEAR.name}`);
    log(`✓ ${LAST_YEAR} → ACTIVE, ${CURRENT_YEAR} → UPCOMING, ${students.count} student status(es) → ENROLLED`);
  });
}

// ==========================================
// SEED
// ==========================================

async function seedDemo() {
  if (await prisma.academicYear.findUnique({ where: { name: NEXT_YEAR.name } })) {
    console.log(`Demo data already exists (academic year ${NEXT_YEAR.name} found). Run "npm run db:reset:demo" to rebuild it.`);
    return;
  }

  // Deterministic ordering so every run produces the same school
  const students = await prisma.studentProfile.findMany({ orderBy: [{ dateOfBirth: 'asc' }, { studentIdentifier: 'asc' }] });
  const staff = await prisma.staffProfile.findMany({ orderBy: { nationalIdNo: 'asc' } });
  if (students.length < 100 || staff.length < 24) {
    throw new Error(`Need ≥ 100 students and ≥ 24 staff (found ${students.length} / ${staff.length}). Run db:seed:students and db:seed:staff first.`);
  }
  if (await prisma.yearlyEnrollment.count()) throw new Error('Enrollments already exist; run "npm run db:reset:demo" to start from a clean state.');

  const byYear = (y: number) => students.filter((s) => s.dateOfBirth.getUTCFullYear() === y);
  const [s2012, s2013, s2014] = [byYear(2012), byYear(2013), byYear(2014)];

  // Cohorts (oldest first within each birth year)
  const repeater = s2012[0]; // grade 9 last year, repeats grade 9
  const graduate = s2012[1]; // grade 9 last year, status GRADUATED (cannot be enrolled)
  const grade10 = s2012.slice(2, 22); // 20 → promoted from 9A last year
  const grade9 = s2013.slice(0, 20); // 20 → promoted from 8A last year
  const notNewAdmission = s2013.slice(20, 22); // enrolled last year, not this year → NOT_A_NEW_ADMISSION when enrolled as new
  const grade8 = s2013.slice(22, 46); // 24 → new admissions
  const grade7 = s2014.slice(0, 23); // 23 → 7A full (12), 7B 11/12

  console.log('Seeding demo school…');

  // ── 1. Last year (2025-2026): history classes + enrollments, then complete it
  const lastYear = await prisma.academicYear.findUnique({ where: { name: LAST_YEAR } });
  if (!lastYear) throw new Error(`Academic year ${LAST_YEAR} not found`);
  if (lastYear.status === AcademicYearStatus.COMPLETED) await updateAcademicYear(lastYear.id, { status: AcademicYearStatus.ACTIVE });
  const grades = Object.fromEntries((await prisma.grade.findMany()).map((g) => [g.gradeNumber, g]));

  const last8A = await createClassSection({ sectionName: 'A', maxCapacity: 40, gradeId: grades[8].id, academicYearId: lastYear.id });
  const last9A = await createClassSection({ sectionName: 'A', maxCapacity: 40, gradeId: grades[9].id, academicYearId: lastYear.id });
  await assignHomeroom({ staffId: staff[0].id, classSectionId: last8A.id, academicYearName: LAST_YEAR });
  await assignHomeroom({ staffId: staff[1].id, classSectionId: last9A.id, academicYearName: LAST_YEAR });
  for (const s of [...grade9, ...notNewAdmission]) await enrollStudentInClass(s.id, last8A.id, lastYear.id);
  for (const s of [...grade10, repeater, graduate]) await enrollStudentInClass(s.id, last9A.id, lastYear.id);
  await updateAcademicYear(lastYear.id, { status: AcademicYearStatus.COMPLETED });
  log(`✓ ${LAST_YEAR}: classes 8A (22) + 9A (22) with homeroom teachers → COMPLETED`);

  // ── 2. Current year ACTIVE, next year UPCOMING
  const currentYear = await prisma.academicYear.findUnique({ where: { name: CURRENT_YEAR } });
  if (!currentYear) throw new Error(`Academic year ${CURRENT_YEAR} not found`);
  await updateAcademicYear(currentYear.id, { status: AcademicYearStatus.ACTIVE });
  await createAcademicYear({ ...NEXT_YEAR, status: AcademicYearStatus.UPCOMING });
  log(`✓ ${CURRENT_YEAR} → ACTIVE, ${NEXT_YEAR.name} created (UPCOMING)`);

  // ── 3. Current year: grades 7–12 × A/B, one homeroom teacher each
  const cls: Record<string, { id: string }> = {};
  let teacher = 0;
  for (const gradeNumber of [7, 8, 9, 10, 11, 12]) {
    for (const sectionName of SECTIONS) {
      const c = await createClassSection({ sectionName, maxCapacity: CAPACITY, gradeId: grades[gradeNumber].id, academicYearId: currentYear.id });
      await assignHomeroom({ staffId: staff[teacher++].id, classSectionId: c.id, academicYearName: CURRENT_YEAR });
      cls[`${gradeNumber}${sectionName}`] = c;
    }
  }
  log(`✓ ${CURRENT_YEAR}: 12 class sections (7A–12B, capacity ${CAPACITY}), homeroom teachers = first 12 staff`);

  // ── 4. Current year enrollments
  const enrollNew = async (list: typeof students, className: string) => {
    for (const s of list) await enrollStudentInClass(s.id, cls[className].id, currentYear.id);
  };
  const enrollContinuing = async (list: typeof students, className: string, type: 'PROMOTED' | 'REPEATING') => {
    for (const s of list) await enrollContinuingStudent(s.id, cls[className].id, currentYear.id, EnrollmentType[type]);
  };
  await enrollNew(grade7.slice(0, 12), '7A');
  await enrollNew(grade7.slice(12), '7B');
  await enrollNew(grade8.slice(0, 12), '8A');
  await enrollNew(grade8.slice(12), '8B');
  await enrollContinuing(grade9.slice(0, 10), '9A', 'PROMOTED');
  await enrollContinuing(grade9.slice(10), '9B', 'PROMOTED');
  await enrollContinuing([repeater], '9B', 'REPEATING');
  await enrollContinuing(grade10.slice(0, 10), '10A', 'PROMOTED');
  await enrollContinuing(grade10.slice(10), '10B', 'PROMOTED');
  log('✓ enrollments: 7A 12 (FULL) · 7B 11 · 8A 12 · 8B 12 (FULL) · 9A 10 · 9B 11 (incl. 1 REPEATING) · 10A 10 · 10B 10 · 11–12 empty');

  // ── 5. Student statuses
  const dropout = grade8[11]; // last student placed in 8A
  await updateStudent(dropout.id, { status: StudentStatus.DROPPED_OUT });
  await updateStudent(graduate.id, { status: StudentStatus.GRADUATED });
  log(`✓ ${dropout.studentIdentifier} DROPPED_OUT (8A seat freed: 11/12) · ${graduate.studentIdentifier} GRADUATED`);

  // ── 6. Demo logins (one per role + edge cases)
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.latinName, r.id]));
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const accounts = [
    { username: 'demo.principal', staffId: staff[20].id, role: 'Principal' },
    { username: 'demo.registrar', staffId: staff[21].id, role: 'Registrar' },
    { username: 'demo.teacher', staffId: staff[0].id, role: 'Teacher' }, // homeroom teacher of 7A
    { username: 'demo.newstaff', staffId: staff[22].id, role: 'Teacher', mustChangePassword: true },
    { username: 'demo.suspended', staffId: staff[23].id, role: 'Teacher', suspended: true },
    { username: 'demo.student', studentId: grade7[0].id, role: SYSTEM_ROLES.STUDENT }, // in 7A
  ];
  for (const a of accounts) {
    const profile = a.staffId ? { staffId: a.staffId } : { studentId: a.studentId! };
    const { user } = await createLogin({ ...profile, username: a.username, roleIds: [roles[a.role]] });
    // Known password for testing; createLogin always forces a change, which demo accounts skip (except demo.newstaff)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: a.mustChangePassword ?? false } });
    if (a.suspended) await setStatus('demo-seed', user.id, UserStatus.SUSPENDED);
  }

  // ── Summary
  const rosters = await prisma.classSection.findMany({
    where: { academicYearId: currentYear.id },
    include: { grade: true, homeroomTeacher: true, enrollments: { include: { student: true } } },
    orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });
  const unenrolled = await prisma.studentProfile.count({ where: { enrollments: { none: { academicYearId: currentYear.id } } } });
  console.log(`\nDemo school ready — ${CURRENT_YEAR} (ACTIVE):`);
  for (const c of rosters) {
    const active = c.enrollments.filter((e) => e.student.status === StudentStatus.ENROLLED).length;
    const flag = active >= c.maxCapacity ? '  ← FULL' : active === 0 ? '  (empty)' : '';
    console.log(`  ${`${c.grade.gradeNumber}${c.sectionName}`.padEnd(4)} ${String(active).padStart(2)}/${c.maxCapacity}  homeroom: ${c.homeroomTeacher?.latinName}${flag}`);
  }
  console.log(`  Not enrolled this year: ${unenrolled} students (incl. ${notNewAdmission.map((s) => s.studentIdentifier).join(', ')} with last-year history, ${graduate.studentIdentifier} GRADUATED)`);
  console.log(`\nDemo logins (password: ${DEMO_PASSWORD}):`);
  for (const a of accounts) {
    console.log(`  ${a.username.padEnd(16)} ${a.role}${a.mustChangePassword ? ' — must change password' : ''}${a.suspended ? ' — SUSPENDED' : ''}`);
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to touch demo data with NODE_ENV=production');
  if (process.argv.includes('--reset')) {
    if (!process.argv.includes('--confirm')) {
      console.error(
        `This deletes all class sections and enrollments in ${DEMO_YEARS.join(', ')}, every "${DEMO_USERNAME_PREFIX}*" login and resets all student statuses.\n` +
          'Re-run with --confirm to proceed:  npm run db:reset:demo -- --confirm',
      );
      process.exitCode = 1;
      return;
    }
    await resetDemo();
  }
  await seedDemo();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? `${(err as { code?: string }).code ?? 'ERROR'}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
