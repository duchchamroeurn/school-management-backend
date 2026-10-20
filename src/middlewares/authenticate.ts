import { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';
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
      throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    }

    let payload;
    try {
      payload = verifyAccessToken(header.slice('Bearer '.length));
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { userRoles: { include: { role: { include: { rolePermissions: { include: { permission: true } } } } } } },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Account is not active');
    }
    // JWT iat is in seconds; reject tokens issued before the last password change
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Token was issued before the last password change');
    }
    if (user.mustChangePassword && !allowPendingPasswordChange) {
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing');
    }

    req.user = {
      id: user.id,
      username: user.username,
      mustChangePassword: user.mustChangePassword,
      roles: user.userRoles.map((ur) => ur.role.latinName),
      permissions: [...new Set(user.userRoles.flatMap((ur) => ur.role.rolePermissions.map((rp) => rp.permission.code)))],
    };
    next();
  };
