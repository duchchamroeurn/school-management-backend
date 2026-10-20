import { Errors } from '../constants/errors';
import { PERMISSION_DEFINITIONS } from '../constants/permissions';
import { Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

// Permissions are defined in code (each one is enforced by a route), so roles are built from this catalogue.
// Custom roles can be created and edited freely; system roles (isSystemDefault) are owned by the seed.

export interface CreateRoleInput {
  khmerName: string;
  latinName: string;
  permissionCodes: string[];
}

export type UpdateRoleInput = Partial<Pick<CreateRoleInput, 'khmerName' | 'latinName'>>;

const roleDetails = {
  rolePermissions: { include: { permission: true }, orderBy: { permission: { code: 'asc' } } },
  _count: { select: { userRoles: true } },
} satisfies Prisma.RoleInclude;

type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof roleDetails }>;

const toDto = ({ rolePermissions, ...role }: RoleWithPermissions) => ({
  ...role,
  permissions: rolePermissions.map((rp) => rp.permission),
});


/**
 * Privilege-escalation guard: an actor can only grant permissions they hold themselves.
 * `actorPermissions` undefined = internal call (seed), no check.
 */
export function assertCanGrant(actorPermissions: string[] | undefined, codes: string[]) {
  if (!actorPermissions) return;
  const notHeld = [...new Set(codes)].filter((c) => !actorPermissions.includes(c));
  if (notHeld.length) {
    throw Errors.CANNOT_GRANT_PERMISSION(notHeld);
  }
}

function assertKnownCodes(codes: string[]) {
  const known = new Set(PERMISSION_DEFINITIONS.map((p) => p.code as string));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    throw Errors.UNKNOWN_PERMISSION(unknown);
  }
  if (!codes.length) {
    throw Errors.PERMISSION_CODES_REQUIRED();
  }
}

async function loadRole(db: Prisma.TransactionClient, id: string) {
  const role = await db.role.findUnique({ where: { id }, include: roleDetails });
  if (!role) throw Errors.ROLE_NOT_FOUND();
  return role;
}

function assertCustom(role: { isSystemDefault: boolean; latinName: string }) {
  if (role.isSystemDefault) {
    throw Errors.SYSTEM_ROLE_IMMUTABLE(role.latinName);
  }
}

async function assertNameFree(db: Prisma.TransactionClient, latinName: string, exceptId?: string) {
  const existing = await db.role.findFirst({ where: { latinName: { equals: latinName, mode: 'insensitive' } } });
  if (existing && existing.id !== exceptId) {
    throw Errors.ROLE_NAME_EXISTS(existing.latinName);
  }
}

async function permissionIds(db: Prisma.TransactionClient, codes: string[]) {
  const rows = await db.permission.findMany({ where: { code: { in: codes } }, select: { id: true } });
  return rows.map((p) => p.id);
}

/** Permission catalogue, grouped by module, for building roles. */
export async function listPermissions() {
  const permissions = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
  const modules = new Map<string, typeof permissions>();
  for (const p of permissions) modules.set(p.module, [...(modules.get(p.module) ?? []), p]);
  return [...modules].map(([module, perms]) => ({ module, permissions: perms }));
}

export function listRoles() {
  return prisma.role.findMany({
    orderBy: [{ isSystemDefault: 'desc' }, { latinName: 'asc' }],
    include: { _count: { select: { rolePermissions: true, userRoles: true } } },
  });
}

export async function getRole(id: string) {
  return toDto(await loadRole(prisma, id));
}

export async function createRole(actorPermissions: string[] | undefined, data: CreateRoleInput) {
  const codes = [...new Set(data.permissionCodes)];
  assertKnownCodes(codes);
  assertCanGrant(actorPermissions, codes);

  try {
    const role = await prisma.$transaction(async (tx) => {
      await assertNameFree(tx, data.latinName);
      const ids = await permissionIds(tx, codes);
      return tx.role.create({
        data: {
          khmerName: data.khmerName,
          latinName: data.latinName,
          isSystemDefault: false,
          rolePermissions: { create: ids.map((permissionId) => ({ permissionId })) },
        },
        include: roleDetails,
      });
    });
    return toDto(role);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw Errors.ROLE_NAME_EXISTS(data.latinName);
    }
    throw err;
  }
}

export async function updateRole(id: string, data: UpdateRoleInput) {
  const role = await prisma.$transaction(async (tx) => {
    assertCustom(await loadRole(tx, id));
    if (data.latinName) await assertNameFree(tx, data.latinName, id);
    await tx.role.update({ where: { id }, data });
    return loadRole(tx, id);
  });
  return toDto(role);
}

/** Replaces the role's full permission set. Takes effect on users' next request. */
export async function setRolePermissions(actorPermissions: string[] | undefined, id: string, permissionCodes: string[]) {
  const codes = [...new Set(permissionCodes)];
  assertKnownCodes(codes);
  assertCanGrant(actorPermissions, codes);

  const role = await prisma.$transaction(async (tx) => {
    assertCustom(await loadRole(tx, id));
    const ids = await permissionIds(tx, codes);
    await tx.rolePermission.deleteMany({ where: { roleId: id, permissionId: { notIn: ids } } });
    await tx.rolePermission.createMany({ data: ids.map((permissionId) => ({ roleId: id, permissionId })), skipDuplicates: true });
    return loadRole(tx, id);
  });
  return toDto(role);
}

export async function deleteRole(id: string) {
  await prisma.$transaction(async (tx) => {
    const role = await loadRole(tx, id);
    assertCustom(role);
    if (role._count.userRoles > 0) {
      throw Errors.ROLE_IN_USE(role.latinName, role._count.userRoles);
    }
    // role_permissions rows cascade
    await tx.role.delete({ where: { id } });
  });
}
