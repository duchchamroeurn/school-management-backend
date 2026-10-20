// Seeds base reference data: system permissions, immutable system roles, school settings, the grades
// for the school level (SCHOOL_LEVEL on first install), MoEYS subjects, and the root System Admin login.
// Every write is an upsert/create-if-missing, so this is safe to run repeatedly (`npm run db:seed`).
import { DEFAULT_SUBJECTS } from '../constants/curriculum';
import {
  ALL_PERMISSION_CODES,
  fullAccess,
  PERMISSION_DEFINITIONS,
  PermissionCode,
  PERMISSIONS,
  readOnly,
} from '../constants/permissions';
import { gradesFor, LEVEL_LABEL } from '../constants/school-levels';
import { prisma } from '../lib/prisma';
import { addMissingGrades, ensureSchoolSettings } from '../services/school-settings.service';
import { hashPassword } from './password';

// ==========================================
// 1. IMMUTABLE SYSTEM ROLES
// (permission codes live in src/constants/permissions.ts)
// ==========================================

const SYSTEM_ADMIN_ROLE = 'System Admin';

const { USER, ROLE, STUDENT } = PERMISSIONS;
const OWN_PROFILE = PERMISSIONS.SELF_SERVICE.VIEW_OWN_PROFILE;
const ACADEMIC_REFERENCE = ['SUBJECT', 'GRADE', 'ACADEMIC_YEAR', 'CLASS_SECTION'] as const;

// isSystemDefault = true: the API must block renaming/deleting these and editing their permissions.
// The seed re-syncs their permissions to exactly this list on every run.
const ROLES: { latinName: string; khmerName: string; permissions: PermissionCode[] }[] = [
  { latinName: SYSTEM_ADMIN_ROLE, khmerName: 'អ្នកគ្រប់គ្រងប្រព័ន្ធ', permissions: ALL_PERMISSION_CODES },
  {
    // Everything except managing logins, roles and system configuration (may still look them up)
    latinName: 'Principal',
    khmerName: 'នាយកសាលា',
    permissions: ALL_PERMISSION_CODES.filter(
      (c) =>
        !(
          [USER.CREATE, USER.UPDATE, USER.DELETE, ROLE.CREATE, ROLE.UPDATE, ROLE.DELETE, PERMISSIONS.SCHOOL_SETTINGS.UPDATE] as PermissionCode[]
        ).includes(c),
    ),
  },
  {
    // Student intake + enrollment; reads academic structure to place students. Cannot delete students.
    latinName: 'Registrar',
    khmerName: 'រដ្ឋបាល',
    permissions: [
      STUDENT.LIST,
      STUDENT.VIEW,
      STUDENT.CREATE,
      STUDENT.UPDATE,
      ...fullAccess('ENROLLMENT'),
      ...readOnly(...ACADEMIC_REFERENCE),
      OWN_PROFILE,
    ],
  },
  {
    latinName: 'Teacher',
    khmerName: 'គ្រូបង្រៀន',
    permissions: [...readOnly('STUDENT', 'ENROLLMENT', ...ACADEMIC_REFERENCE), OWN_PROFILE],
  },
  { latinName: 'Student', khmerName: 'សិស្ស', permissions: [OWN_PROFILE] },
];

// ==========================================
// 3. GRADES & SUBJECTS — see src/constants/curriculum.ts and school-levels.ts
// ==========================================

// ==========================================
// 4. ROOT ADMIN
// ==========================================

const ROOT_ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
// Default initial password — must be changed after first login. Override with SEED_ADMIN_PASSWORD.
const ROOT_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123!';

// ==========================================
// RUN
// ==========================================

async function seedPermissions() {
  for (const p of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({ where: { code: p.code }, update: p, create: p });
  }
  // Permissions are defined in code; remove retired codes (their role grants cascade)
  const retired = await prisma.permission.deleteMany({ where: { code: { notIn: ALL_PERMISSION_CODES } } });
  console.log(`  ✓ ${PERMISSION_DEFINITIONS.length} permissions${retired.count ? ` (${retired.count} retired removed)` : ''}`);
}

async function seedRoles() {
  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, code: true } })).map((p) => [p.code, p.id]),
  );

  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { latinName: r.latinName },
      update: { khmerName: r.khmerName, isSystemDefault: true },
      create: { latinName: r.latinName, khmerName: r.khmerName, isSystemDefault: true },
    });

    const wantedIds = r.permissions.map((code) => permissionIds.get(code)!);
    for (const permissionId of wantedIds) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
    // Immutable: drop any grant that isn't in the definition above
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wantedIds } } });
  }
  console.log(`  ✓ ${ROLES.length} system roles (permissions synced)`);
}

async function seedGradesAndSubjects() {
  // School level: from SCHOOL_LEVEL on first install, afterwards from the database (change it via the API)
  const { level } = await ensureSchoolSettings();
  const addedGrades = await addMissingGrades(prisma, level);

  // Subjects are seeded once: after that they (and their grade assignments) are managed via the
  // Subjects API, so existing subjects are never overwritten and unassigned grades are not re-added.
  const gradeIds = new Map(
    (await prisma.grade.findMany({ select: { id: true, gradeNumber: true } })).map((g) => [g.gradeNumber, g.id]),
  );
  let created = 0;
  for (const { grades, ...s } of DEFAULT_SUBJECTS) {
    if (await prisma.subject.findUnique({ where: { code: s.code } })) continue;
    await prisma.subject.create({
      data: { ...s, gradeSubjects: { create: grades.filter((n) => gradeIds.has(n)).map((n) => ({ gradeId: gradeIds.get(n)! })) } },
    });
    created++;
  }
  console.log(`  ✓ school level: ${LEVEL_LABEL[level]}`);
  console.log(
    `  ✓ grades ${gradesFor(level).join(', ')}${addedGrades.length ? ` (${addedGrades.length} newly created)` : ''}, ${DEFAULT_SUBJECTS.length} default subjects (${created} newly created)`,
  );
}

async function seedRootAdmin() {
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { latinName: SYSTEM_ADMIN_ROLE } });

  // update: {} — never overwrite a password the admin has already changed.
  // mustChangePassword: the default password is public, so it must be replaced on first login.
  const user = await prisma.user.upsert({
    where: { username: ROOT_ADMIN_USERNAME },
    update: {},
    create: {
      username: ROOT_ADMIN_USERNAME,
      passwordHash: await hashPassword(ROOT_ADMIN_PASSWORD),
      mustChangePassword: true,
    },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
    update: {},
    create: { userId: user.id, roleId: adminRole.id },
  });
  console.log(`  ✓ root admin "${ROOT_ADMIN_USERNAME}" (${SYSTEM_ADMIN_ROLE})`);
}

async function main() {
  console.log('Seeding database...');
  await seedPermissions();
  await seedRoles();
  await seedGradesAndSubjects();
  await seedRootAdmin();
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
