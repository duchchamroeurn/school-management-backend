import { NextFunction, Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { PermissionCode } from '../constants/permissions';

// Use after authenticate(). The user must hold ALL listed permission codes (via any of their roles).
export const requirePermission =
  (...codes: PermissionCode[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw Errors.AUTH_REQUIRED();
    }
    const missing = codes.filter((code) => !req.user!.permissions.includes(code));
    if (missing.length) {
      throw Errors.FORBIDDEN(missing);
    }
    next();
  };
