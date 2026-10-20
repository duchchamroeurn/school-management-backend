import { Errors } from '../constants/errors';
import { SYSTEM_ROLES } from '../constants/roles';
import { Prisma, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { checkPasswordPolicy, generateTemporaryPassword, hashPassword } from '../utils/password';
import { audit } from './audit.service';
import { assertCanGrant } from './role.service';

export type ProfileRef = { staffId: string; studentId?: undefined } | { studentId: string; staffId?: undefined };

export type CreateLoginInput = ProfileRef & {
  username: string;
  roleIds?: string[]; // required for staff; student logins always get the Student role
  temporaryPassword?: string; // generated when omitted
};

export interface ListUsersFilter {
  search?: string; // username or profile name
  status?: UserStatus;
  roleId?: string;
  skip: number;
  take: number;
}

const userInclude = {
  userRoles: { include: { role: { select: { id: true, khmerName: true, latinName: true } } }, orderBy: { assignedAt: 'asc' } },
  staffProfile: { select: { id: true, khmerName: true, latinName: true } },
  studentProfile: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true } },
} satisfies Prisma.UserInclude;

type UserWithRelations = Prisma.UserGetPayload<{ include: typeof userInclude }>;

// Public shape — never exposes passwordHash
function toDto(user: UserWithRelations) {
  const profile = user.staffProfile
    ? { type: 'STAFF' as const, ...user.staffProfile }
    : user.studentProfile
      ? { type: 'STUDENT' as const, ...user.studentProfile }
      : null;
  return {
    id: user.id,
    username: user.username,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    passwordChangedAt: user.passwordChangedAt,
    createdAt: user.createdAt,
    roles: user.userRoles.map((ur) => ur.role),
    profile,
  };
}

// What the audit log keeps about a login (never the password hash)
const auditSnapshot = (user: UserWithRelations) => ({
  username: user.username,
  status: user.status,
  roles: user.userRoles.map((ur) => ur.role.latinName).sort(),
  profile: toDto(user).profile,
});

const auditUser = (user: UserWithRelations) => ({ entityType: 'User', entityId: user.id, entityLabel: user.username }) as const;

// Arbitrary constant identifying the "admin safety" lock: serialises role/status/delete changes
// so two admins can't simultaneously remove each other and leave no active System Admin.
const ADMIN_GUARD_LOCK = 7_260_002;
const lockAdminGuard = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK})`;

const isAdmin = (user: UserWithRelations) => user.userRoles.some((ur) => ur.role.latinName === SYSTEM_ROLES.SYSTEM_ADMIN);

async function assertNotLastActiveAdmin(tx: Prisma.TransactionClient, user: UserWithRelations, action: string) {
  if (!isAdmin(user) || user.status !== UserStatus.ACTIVE) return;
  const otherActiveAdmins = await tx.user.count({
    where: {
      id: { not: user.id },
      status: UserStatus.ACTIVE,
      userRoles: { some: { role: { latinName: SYSTEM_ROLES.SYSTEM_ADMIN } } },
    },
  });
  if (otherActiveAdmins === 0) {
    throw Errors.LAST_SYSTEM_ADMIN(action, user.username);
  }
}

function assertNotSelf(actorId: string, userId: string, action: string) {
  if (actorId === userId) throw Errors.CANNOT_MODIFY_SELF(action);
}

function resolvePassword(temporaryPassword?: string) {
  if (temporaryPassword === undefined) return generateTemporaryPassword();
  const problems = checkPasswordPolicy(temporaryPassword);
  if (problems.length) {
    throw Errors.WEAK_PASSWORD('temporaryPassword', problems);
  }
  return temporaryPassword;
}

/** Validates role ids against the profile type: Student role only (and always) for student logins. */
async function resolveRoles(tx: Prisma.TransactionClient, roleIds: string[] | undefined, profileType: 'STAFF' | 'STUDENT') {
  if (profileType === 'STUDENT') {
    const studentRole = await tx.role.findUniqueOrThrow({ where: { latinName: SYSTEM_ROLES.STUDENT } });
    if (roleIds?.some((id) => id !== studentRole.id)) {
      throw Errors.STUDENT_ROLE_ONLY();
    }
    return [studentRole];
  }

  if (!roleIds?.length) {
    throw Errors.STAFF_ROLE_REQUIRED();
  }
  const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
  const missing = roleIds.filter((id) => !roles.some((r) => r.id === id));
  if (missing.length) throw Errors.ROLES_NOT_FOUND(missing);
  if (roles.some((r) => r.latinName === SYSTEM_ROLES.STUDENT)) {
    throw Errors.STUDENT_ROLE_RESERVED();
  }
  return roles;
}

// Privilege-escalation guard: the actor must hold every permission the assigned roles carry
async function assertCanAssign(tx: Prisma.TransactionClient, actorPermissions: string[] | undefined, roleIds: string[]) {
  if (!actorPermissions) return;
  const granted = await tx.rolePermission.findMany({ where: { roleId: { in: roleIds } }, select: { permission: { select: { code: true } } } });
  assertCanGrant(actorPermissions, granted.map((g) => g.permission.code));
}

async function loadUser(tx: Prisma.TransactionClient, id: string) {
  const user = await tx.user.findUnique({ where: { id }, include: userInclude });
  if (!user) throw Errors.USER_NOT_FOUND();
  return user;
}

export async function listUsers(filter: ListUsersFilter) {
  const where: Prisma.UserWhereInput = {
    status: filter.status,
    ...(filter.roleId && { userRoles: { some: { roleId: filter.roleId } } }),
    ...(filter.search && {
      OR: [
        { username: { contains: filter.search, mode: 'insensitive' } },
        { staffProfile: { OR: [{ khmerName: { contains: filter.search } }, { latinName: { contains: filter.search, mode: 'insensitive' } }] } },
        { studentProfile: { OR: [{ khmerName: { contains: filter.search } }, { latinName: { contains: filter.search, mode: 'insensitive' } }, { studentIdentifier: { contains: filter.search, mode: 'insensitive' } }] } },
      ],
    }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.user.findMany({ where, include: userInclude, orderBy: { username: 'asc' }, skip: filter.skip, take: filter.take }),
    prisma.user.count({ where }),
  ]);
  return { items: items.map(toDto), total };
}

export async function getUser(id: string) {
  return toDto(await loadUser(prisma, id));
}

/**
 * Create Login: a user account always belongs to exactly one staff OR student profile (1:1).
 * The profile row is locked so two simultaneous requests can't both attach a login to it.
 */
// actorPermissions undefined = internal call (seed), no escalation check
export async function createLogin(input: CreateLoginInput, actorPermissions?: string[]) {
  const profileType = input.staffId ? 'STAFF' : 'STUDENT';
  const profileId = input.staffId ?? input.studentId;
  const password = resolvePassword(input.temporaryPassword);
  const passwordHash = await hashPassword(password);

  try {
    const user = await prisma.$transaction(async (tx) => {
      const [locked] =
        profileType === 'STAFF'
          ? await tx.$queryRaw<{ id: string; user_id: string | null }[]>`SELECT id, user_id FROM staff_profiles WHERE id = ${profileId} FOR UPDATE`
          : await tx.$queryRaw<{ id: string; user_id: string | null }[]>`SELECT id, user_id FROM student_profiles WHERE id = ${profileId} FOR UPDATE`;
      if (!locked) {
        throw profileType === 'STAFF'
          ? Errors.STAFF_NOT_FOUND()
          : Errors.STUDENT_NOT_FOUND();
      }
      if (locked.user_id) {
        const existing = await tx.user.findUnique({ where: { id: locked.user_id } });
        throw Errors.PROFILE_HAS_LOGIN(profileType.toLowerCase(), existing?.username, locked.user_id);
      }
      if (await tx.user.findUnique({ where: { username: input.username } })) {
        throw Errors.USERNAME_TAKEN(input.username);
      }

      const roles = await resolveRoles(tx, input.roleIds, profileType);
      await assertCanAssign(tx, actorPermissions, roles.map((r) => r.id));
      const created = await tx.user.create({
        data: {
          username: input.username,
          passwordHash,
          mustChangePassword: true,
          userRoles: { create: roles.map((r) => ({ roleId: r.id })) },
          ...(profileType === 'STAFF' ? { staffProfile: { connect: { id: profileId } } } : { studentProfile: { connect: { id: profileId } } }),
        },
        include: userInclude,
      });
      await audit(tx, { ...auditUser(created), action: 'USER_CREATED', after: auditSnapshot(created) });
      return created;
    });
    // The temporary password is returned only here; it is never stored or retrievable again
    return { user: toDto(user), temporaryPassword: password, mustChangePassword: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw Errors.USERNAME_TAKEN(input.username);
    }
    throw err;
  }
}

/** Assign Role: replaces the user's full role set. */
export async function assignRoles(actorId: string, userId: string, roleIds: string[], actorPermissions?: string[]) {
  const user = await prisma.$transaction(async (tx) => {
    await lockAdminGuard(tx);
    const current = await loadUser(tx, userId);
    const profileType = current.studentProfile ? 'STUDENT' : 'STAFF';
    const roles = await resolveRoles(tx, roleIds, profileType);
    await assertCanAssign(tx, actorPermissions, roles.map((r) => r.id));

    if (!roles.some((r) => r.latinName === SYSTEM_ROLES.SYSTEM_ADMIN)) {
      await assertNotLastActiveAdmin(tx, current, 'remove the System Admin role');
      if (isAdmin(current)) assertNotSelf(actorId, userId, 'remove the System Admin role from');
    }

    await tx.userRole.deleteMany({ where: { userId, roleId: { notIn: roles.map((r) => r.id) } } });
    await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id })), skipDuplicates: true });
    const updated = await loadUser(tx, userId);
    await audit(tx, { ...auditUser(updated), action: 'USER_ROLES_CHANGED', before: auditSnapshot(current), after: auditSnapshot(updated) });
    return updated;
  });
  return toDto(user);
}

/** Suspend / reactivate. Takes effect on the user's next request (authenticate re-reads status). */
export async function setStatus(actorId: string, userId: string, status: UserStatus) {
  const user = await prisma.$transaction(async (tx) => {
    await lockAdminGuard(tx);
    const current = await loadUser(tx, userId);
    if (status === UserStatus.SUSPENDED) {
      assertNotSelf(actorId, userId, 'suspend');
      await assertNotLastActiveAdmin(tx, current, 'suspend this account');
    }
    await tx.user.update({ where: { id: userId }, data: { status } });
    const updated = await loadUser(tx, userId);
    await audit(tx, { ...auditUser(updated), action: 'USER_STATUS_CHANGED', before: auditSnapshot(current), after: auditSnapshot(updated) });
    return updated;
  });
  return toDto(user);
}

/** Reset Password: new temporary password, forced change at next login, all existing tokens revoked. */
export async function resetPassword(userId: string, temporaryPassword?: string) {
  await loadUser(prisma, userId);
  const password = resolvePassword(temporaryPassword);
  const passwordHash = await hashPassword(password);
  // Whole seconds, matching JWT iat precision (see authenticate middleware)
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true, passwordChangedAt: changedAt },
      include: userInclude,
    });
    // The temporary password itself is never recorded
    await audit(tx, { ...auditUser(updated), action: 'PASSWORD_RESET' });
    return updated;
  });
  return { user: toDto(user), temporaryPassword: password, mustChangePassword: true };
}

/** Removes the login only; the staff/student profile is kept (its userId becomes null). */
export async function deleteLogin(actorId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    await lockAdminGuard(tx);
    assertNotSelf(actorId, userId, 'delete');
    const current = await loadUser(tx, userId);
    await assertNotLastActiveAdmin(tx, current, 'delete this account');
    await tx.user.delete({ where: { id: userId } });
    await audit(tx, { ...auditUser(current), action: 'USER_DELETED', before: auditSnapshot(current) });
  });
}
