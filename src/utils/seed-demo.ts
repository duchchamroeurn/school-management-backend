// Builds a complete demo school on top of the imported students/staff so every feature can be tested.
// Everything goes through the service layer, so demo data obeys the same rules as the API.
// Classes are created only for the grades the school level offers (see /api/v1/school-settings).
//
//   npm run db:seed:demo                        # build the demo (once; refuses if already built)
//   npm run db:reset:demo -- --confirm          # remove demo data, restore the years, rebuild
//   npm run db:reset:demo -- --confirm --clear  # remove demo data only (e.g. before changing school level)
//
// Requires: npm run db:seed (reference data), db:seed:students and db:seed:staff (≥ 80 / ≥ 24 records).
// Never runs automatically and refuses to run with NODE_ENV=production.
import { SYSTEM_ROLES } from '../constants/roles';
import { gradesFor, LEVEL_LABEL } from '../constants/school-levels';
import { AcademicYearStatus, EnrollmentType, StudentStatus, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { createAcademicYear, updateAcademicYear } from '../services/academic-year.service';
import { createClassSection } from '../services/class-section.service';
import { enrollContinuingStudent, enrollStudentInClass } from '../services/enrollment.service';
import { getSchoolLevel } from '../services/school-settings.service';
import { assignHomeroom } from '../services/staff.service';
import { createTeachingAssignment } from '../services/teacher-assignment.service';
import { updateStudent } from '../services/student.service';
import { createLogin, setStatus } from '../services/user.service';
import { hashPassword } from './password';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';
const CAPACITY = 12;
const SECTIONS = ['A', 'B'];
// Students placed per class, in order (lowest grade A, B, next grade A, B, …); remaining classes stay empty.
// Gives one exactly-full class (first), one with a single free seat, and later partially filled ones.
const FILL_PATTERN = [12, 11, 12, 12, 10, 10, 10, 10];
const REPEATER_CLASS = 5; // index into the class list: third grade, section B
const DROPOUT_CLASS = 2; // second grade, section A — one student drops out, freeing a seat

const LAST_YEAR = '2025-2026';
const CURRENT_YEAR = '2026-2027';
const NEXT_YEAR = { name: '2027-2028', startDate: new Date('2027-11-01'), endDate: new Date('2028-08-31') };
const DEMO_YEARS = [LAST_YEAR, CURRENT_YEAR, NEXT_YEAR.name];
// Created by the demo when missing (e.g. after a database reset)
const PREVIOUS_YEARS = [
  { name: LAST_YEAR, startDate: new Date('2025-11-01'), endDate: new Date('2026-08-31'), status: AcademicYearStatus.ACTIVE },
  { name: CURRENT_YEAR, startDate: new Date('2026-11-01'), endDate: new Date('2027-08-31'), status: AcademicYearStatus.UPCOMING },
];
const DEMO_USERNAME_PREFIX = 'demo.';

const log = (msg: string) => console.log(`  ${msg}`);

// ==========================================
// RESET
// ==========================================

async function resetDemo() {
  console.log('Removing demo data…');
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
    console.log(`Demo data already exists (academic year ${NEXT_YEAR.name} found). Run "npm run db:reset:demo -- --confirm" to rebuild it.`);
    return;
  }

  const level = await getSchoolLevel();
  const offered = gradesFor(level);
  const grades = Object.fromEntries((await prisma.grade.findMany()).map((g) => [g.gradeNumber, g]));
  const missing = offered.filter((n) => !grades[n]);
  if (missing.length) throw new Error(`Grade(s) ${missing.join(', ')} missing — run "npm run db:seed" first`);

  // Youngest first: younger students go into lower grades. Deterministic so every run builds the same school.
  const pool = await prisma.studentProfile.findMany({ orderBy: [{ dateOfBirth: 'desc' }, { studentIdentifier: 'asc' }] });
  const staff = await prisma.staffProfile.findMany({ orderBy: { nationalIdNo: 'asc' } });
  if (pool.length < 80 || staff.length < 24) {
    throw new Error(`Need ≥ 80 students and ≥ 24 staff (found ${pool.length} / ${staff.length}). Run db:seed:students and db:seed:staff first.`);
  }
  if (await prisma.yearlyEnrollment.count()) throw new Error('Enrollments already exist; run "npm run db:reset:demo -- --confirm" to start from a clean state.');

  // Special cases are taken from the oldest students
  const graduate = pool.pop()!; // top grade last year → GRADUATED (cannot be enrolled)
  const repeater = pool.pop()!; // repeats the third grade
  const notNewAdmission = [pool.pop()!, pool.pop()!]; // enrolled last year, not this year

  console.log(`Seeding demo school — ${LEVEL_LABEL[level]}…`);

  // Classes this year in order 7A, 7B, 8A, … with the students planned for each
  const plan = offered.flatMap((gradeNumber, gradeIndex) =>
    SECTIONS.map((sectionName) => ({ gradeNumber, gradeIndex, sectionName })),
  ).map((c, i) => ({ ...c, students: pool.splice(0, FILL_PATTERN[i] ?? 0) }));

  // ── 1. Last year: one history class per grade, enroll everyone who continues, then complete it
  // A fresh database has no years yet: create them as the reset leaves them (last year ACTIVE, this year UPCOMING)
  for (const year of PREVIOUS_YEARS) {
    if (!(await prisma.academicYear.findUnique({ where: { name: year.name } }))) {
      await createAcademicYear(year);
      log(`✓ academic year ${year.name} created (${year.status})`);
    }
  }
  const lastYear = await prisma.academicYear.findUnique({ where: { name: LAST_YEAR } });
  if (!lastYear) throw new Error(`Academic year ${LAST_YEAR} not found`);
  if (lastYear.status === AcademicYearStatus.COMPLETED) await updateAcademicYear(lastYear.id, { status: AcademicYearStatus.ACTIVE });

  const lastYearClass: Record<number, { id: string }> = {};
  for (const [i, gradeNumber] of offered.entries()) {
    lastYearClass[gradeNumber] = await createClassSection({ sectionName: 'A', maxCapacity: 40, gradeId: grades[gradeNumber].id, academicYearId: lastYear.id });
    await assignHomeroom({ staffId: staff[i].id, classSectionId: lastYearClass[gradeNumber].id, academicYearName: LAST_YEAR });
  }
  const lowest = offered[0];
  const top = offered[offered.length - 1];
  const third = offered[Math.min(2, offered.length - 1)];
  // Students above the lowest grade were one grade lower last year
  for (const c of plan.filter((c) => c.gradeIndex > 0)) {
    for (const s of c.students) await enrollStudentInClass(s.id, lastYearClass[offered[c.gradeIndex - 1]].id, lastYear.id);
  }
  await enrollStudentInClass(repeater.id, lastYearClass[third].id, lastYear.id);
  await enrollStudentInClass(graduate.id, lastYearClass[top].id, lastYear.id);
  for (const s of notNewAdmission) await enrollStudentInClass(s.id, lastYearClass[lowest].id, lastYear.id);
  await updateAcademicYear(lastYear.id, { status: AcademicYearStatus.COMPLETED });
  log(`✓ ${LAST_YEAR}: ${offered.length} history classes (${offered.map((n) => `${n}A`).join(', ')}) with homeroom teachers → COMPLETED`);

  // ── 2. Current year ACTIVE, next year UPCOMING
  const currentYear = await prisma.academicYear.findUnique({ where: { name: CURRENT_YEAR } });
  if (!currentYear) throw new Error(`Academic year ${CURRENT_YEAR} not found`);
  await updateAcademicYear(currentYear.id, { status: AcademicYearStatus.ACTIVE });
  await createAcademicYear({ ...NEXT_YEAR, status: AcademicYearStatus.UPCOMING });
  log(`✓ ${CURRENT_YEAR} → ACTIVE, ${NEXT_YEAR.name} created (UPCOMING)`);

  // ── 3. Current year: every offered grade × A/B, one homeroom teacher each
  const classes = [];
  for (const [i, c] of plan.entries()) {
    const created = await createClassSection({ sectionName: c.sectionName, maxCapacity: CAPACITY, gradeId: grades[c.gradeNumber].id, academicYearId: currentYear.id });
    await assignHomeroom({ staffId: staff[i].id, classSectionId: created.id, academicYearName: CURRENT_YEAR });
    classes.push({ ...c, id: created.id, name: `${c.gradeNumber}${c.sectionName}` });
  }
  log(`✓ ${CURRENT_YEAR}: ${classes.length} class sections (${classes[0].name}–${classes[classes.length - 1].name}, capacity ${CAPACITY}), homeroom teachers = first ${classes.length} staff`);

  // ── 3b. Teaching assignments: staff[0] (demo.teacher) teaches two subjects across two classes;
  //        staff[1] teaches Khmer in those classes, so demo.teacher can't score Khmer even in their homeroom
  const subjectId = Object.fromEntries((await prisma.subject.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));
  const teaching = [
    { staffId: staff[0].id, subject: 'MATH', classes: [classes[0], classes[1]] },
    { staffId: staff[0].id, subject: 'PHYSICS', classes: [classes[0]] },
    { staffId: staff[1].id, subject: 'KHMER', classes: [classes[0], classes[1]] },
  ];
  for (const t of teaching) {
    for (const c of t.classes) await createTeachingAssignment({ staffId: t.staffId, subjectId: subjectId[t.subject], classSectionId: c.id });
  }
  log(`✓ teaching assignments: ${staff[0].latinName} MATH ${classes[0].name}+${classes[1].name}, PHYSICS ${classes[0].name} · ${staff[1].latinName} KHMER ${classes[0].name}+${classes[1].name}`);

  // ── 4. Current year enrollments: lowest grade = new admissions, others promoted from last year
  for (const c of classes) {
    for (const s of c.students) {
      if (c.gradeIndex === 0) await enrollStudentInClass(s.id, c.id, currentYear.id);
      else await enrollContinuingStudent(s.id, c.id, currentYear.id, EnrollmentType.PROMOTED);
    }
  }
  const repeaterClass = classes[Math.min(REPEATER_CLASS, classes.length - 1)];
  await enrollContinuingStudent(repeater.id, repeaterClass.id, currentYear.id, EnrollmentType.REPEATING);
  log(`✓ enrollments: ${classes.map((c) => `${c.name} ${c.students.length + (c === repeaterClass ? 1 : 0)}`).join(' · ')} (${repeaterClass.name} incl. 1 REPEATING)`);

  // ── 5. Student statuses
  const dropoutClass = classes[DROPOUT_CLASS];
  const dropout = dropoutClass.students[dropoutClass.students.length - 1];
  await updateStudent(dropout.id, { status: StudentStatus.DROPPED_OUT });
  await updateStudent(graduate.id, { status: StudentStatus.GRADUATED });
  log(`✓ ${dropout.studentIdentifier} DROPPED_OUT (${dropoutClass.name} seat freed) · ${graduate.studentIdentifier} GRADUATED`);

  // ── 6. Demo logins (one per role + edge cases)
  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.latinName, r.id]));
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const accounts = [
    { username: 'demo.principal', staffId: staff[20].id, role: 'Principal' },
    { username: 'demo.registrar', staffId: staff[21].id, role: 'Registrar' },
    { username: 'demo.teacher', staffId: staff[0].id, role: 'Teacher' }, // homeroom of the first class; teaches MATH + PHYSICS
    { username: 'demo.newstaff', staffId: staff[22].id, role: 'Teacher', mustChangePassword: true },
    { username: 'demo.suspended', staffId: staff[23].id, role: 'Teacher', suspended: true },
    { username: 'demo.student', studentId: classes[0].students[0].id, role: SYSTEM_ROLES.STUDENT }, // in the first class
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
  console.log(`\nDemo school ready — ${CURRENT_YEAR} (ACTIVE), ${LEVEL_LABEL[level]}:`);
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
          'Re-run with --confirm to proceed:  npm run db:reset:demo -- --confirm   (add --clear to skip rebuilding)',
      );
      process.exitCode = 1;
      return;
    }
    await resetDemo();
    if (process.argv.includes('--clear')) return;
  }
  await seedDemo();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? `${(err as { code?: string }).code ?? 'ERROR'}: ${err.message}` : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
