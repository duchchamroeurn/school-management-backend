import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';
import { signAccessToken } from '../utils/jwt';
import { checkPasswordPolicy, DUMMY_HASH, hashPassword, verifyPassword } from '../utils/password';

export interface LoginResult {
  accessToken: string;
  mustChangePassword: boolean;
  user: {
    id: string;
    username: string;
    roles: { id: string; khmerName: string; latinName: string }[];
    hasStaffProfile: boolean;
    hasStudentProfile: boolean;
  };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { username },
    include: {
      userRoles: { include: { role: { select: { id: true, khmerName: true, latinName: true } } } },
      staffProfile: { select: { id: true } },
      studentProfile: { select: { id: true } },
    },
  });

  // Always run bcrypt (against a dummy hash for unknown users) so timing doesn't reveal which usernames exist.
  // The password is checked before the status so a wrong guess can't discover that an account is suspended.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
  if (user.status !== 'ACTIVE') {
    throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken: signAccessToken(user.id),
    mustChangePassword: user.mustChangePassword,
    user: {
      id: user.id,
      username: user.username,
      roles: user.userRoles.map((ur) => ur.role),
      hasStaffProfile: user.staffProfile !== null,
      hasStudentProfile: user.studentProfile !== null,
    },
  };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  const problems = checkPasswordPolicy(newPassword);
  if (problems.length) {
    throw new HttpError(400, 'WEAK_PASSWORD', `Password must contain ${problems.join(', ')}`, problems);
  }
  if (newPassword === currentPassword) {
    throw new HttpError(400, 'WEAK_PASSWORD', 'New password must be different from the current password');
  }

  // Truncate to whole seconds so tokens issued right after this (same-second iat) remain valid
  const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt: changedAt },
  });

  // Older tokens are now rejected, so hand back a fresh one
  return { accessToken: signAccessToken(user.id), mustChangePassword: false };
}