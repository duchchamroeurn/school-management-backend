import { NextFunction, Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { prisma } from '../lib/prisma';
import { currentContext } from '../lib/requestContext';
import { verifyAccessToken } from '../utils/jwt';

interface AuthenticateOptions {
  // Only the change-password route should set this
  allowPendingPasswordChange?: boolean;
}

// Verifies the Bearer token and loads the user's current state from the DB on every request,
// so suspensions, role changes and the must-change-password flag take effect immediately.
export const authenticate =
  ({ allowPendingPasswordChange = false }: AuthenticateOptions = {}) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw Errors.MISSING_TOKEN();
    }

    let payload;
    try {
      payload = verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      throw Errors.INVALID_TOKEN();
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw Errors.ACCOUNT_INACTIVE();
    }
    // JWT iat is in seconds; reject tokens issued before the last password change
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw Errors.TOKEN_REVOKED();
    }
    if (user.mustChangePassword && !allowPendingPasswordChange) {
      throw Errors.PASSWORD_CHANGE_REQUIRED();
    }

    req.user = {
      id: user.id,
      username: user.username,
      mustChangePassword: user.mustChangePassword,
      roles: user.userRoles.map((ur) => ur.role.latinName),
      permissions: [...new Set(user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code)))],
    };
    // Lets the audit log record who made each change
    const context = currentContext();
    if (context) context.actor = { id: user.id, username: user.username };
    next();
  };
