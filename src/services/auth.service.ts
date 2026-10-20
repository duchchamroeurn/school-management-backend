import { Errors } from '../constants/errors';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../utils/jwt';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from '../utils/loginThrottle';
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

export async function login(username: string, password: string, clientIp: string): Promise<LoginResult> {
  // Checked before the password, so a locked account rejects even the right one
  assertLoginAllowed(clientIp, username);

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
    recordLoginFailure(clientIp, username);
    throw Errors.INVALID_CREDENTIALS();
  }
  recordLoginSuccess(username);
  if (user.status !== 'ACTIVE') {
    throw Errors.ACCOUNT_SUSPENDED();
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
    throw Errors.WRONG_CURRENT_PASSWORD();
  }

  const problems = checkPasswordPolicy(newPassword);
  if (problems.length) {
    throw Errors.WEAK_PASSWORD('Password', problems);
  }
  if (newPassword === currentPassword) {
    throw Errors.PASSWORD_UNCHANGED();
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