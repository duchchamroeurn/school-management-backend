import { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { HttpError } from '../utils/httpError';

const asString = (value: unknown) => (typeof value === 'string' ? value : '');

// POST /api/v1/auth/login
export async function login(req: Request, res: Response) {
  // Usernames are stored lower-case
  const username = asString(req.body?.username).trim().toLowerCase();
  const password = asString(req.body?.password);
  if (!username || !password) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'username and password are required');
  }

  const result = await authService.login(username, password);
  res.json({ status: 'success', data: result });
}

// POST /api/v1/auth/change-password — the only route usable while mustChangePassword is true
export async function changePassword(req: Request, res: Response) {
  const currentPassword = asString(req.body?.currentPassword);
  const newPassword = asString(req.body?.newPassword);
  if (!currentPassword || !newPassword) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'currentPassword and newPassword are required');
  }

  const result = await authService.changePassword(req.user!.id, currentPassword, newPassword);
  res.json({ status: 'success', data: result });
}

// GET /api/v1/auth/me
export function me(req: Request, res: Response) {
  res.json({ status: 'success', data: req.user });
}
