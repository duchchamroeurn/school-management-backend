import { Request, Response } from 'express';
import { UserStatus } from '../generated/prisma/client';
import * as userService from '../services/user.service';
import { HttpError } from '../utils/httpError';
import {
  bodyOf,
  optionalEnum,
  optionalString,
  optionalStringArray,
  optionalUsername,
  pagination,
  queryString,
  required,
} from '../utils/validate';

const STATUSES = Object.values(UserStatus);

// GET /api/v1/users?search=&status=&roleId=&page=&pageSize=
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await userService.listUsers({
    search: queryString(req.query.search, 'search'),
    status: optionalEnum(queryString(req.query.status, 'status'), 'status', STATUSES),
    roleId: queryString(req.query.roleId, 'roleId'),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/users/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await userService.getUser(req.params.id) });
}

// POST /api/v1/users — Create Login for exactly one staff OR student profile
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const staffId = optionalString(body.staffId, 'staffId');
  const studentId = optionalString(body.studentId, 'studentId');
  if (!staffId === !studentId) {
    throw new HttpError(
      400,
      'PROFILE_REQUIRED',
      staffId
        ? 'A login belongs to one profile: send staffId OR studentId, not both'
        : 'A login must belong to a profile: send staffId or studentId (orphan accounts are not allowed)',
    );
  }

  const common = {
    username: required(optionalUsername(body.username), 'username'),
    roleIds: optionalStringArray(body.roleIds, 'roleIds'),
    temporaryPassword: optionalString(body.temporaryPassword, 'temporaryPassword', 72),
  };
  const result = await userService.createLogin(
    staffId ? { ...common, staffId } : { ...common, studentId: studentId! },
    req.user!.permissions,
  );
  res.status(201).json({ status: 'success', data: result });
}

// PUT /api/v1/users/:id/roles — Assign Role (replaces the full set)
export async function assignRoles(req: Request<{ id: string }>, res: Response) {
  const roleIds = required(optionalStringArray(bodyOf(req).roleIds, 'roleIds'), 'roleIds');
  res.json({ status: 'success', data: await userService.assignRoles(req.user!.id, req.params.id, roleIds, req.user!.permissions) });
}

// PATCH /api/v1/users/:id/status — Suspend / reactivate
export async function setStatus(req: Request<{ id: string }>, res: Response) {
  const status = required(optionalEnum(bodyOf(req).status, 'status', STATUSES), 'status');
  res.json({ status: 'success', data: await userService.setStatus(req.user!.id, req.params.id, status) });
}

// POST /api/v1/users/:id/reset-password — Reset Password (temporaryPassword optional; generated when omitted)
export async function resetPassword(req: Request<{ id: string }>, res: Response) {
  const temporaryPassword = optionalString(bodyOf(req).temporaryPassword, 'temporaryPassword', 72);
  res.json({ status: 'success', data: await userService.resetPassword(req.params.id, temporaryPassword) });
}

// DELETE /api/v1/users/:id — removes the login; the profile is kept
export async function remove(req: Request<{ id: string }>, res: Response) {
  await userService.deleteLogin(req.user!.id, req.params.id);
  res.status(204).end();
}
