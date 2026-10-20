import { NextFunction, Request, Response } from 'express';
import { PermissionCode } from '../constants/permissions';
import { HttpError } from '../utils/httpError';

// Use after authenticate(). The user must hold ALL listed permission codes (via any of their roles).
export const requirePermission =
  (...codes: PermissionCode[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    const missing = codes.filter((code) => !req.user!.permissions.includes(code));
    if (missing.length) {
      throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action', { missing });
    }
    next();
  };
