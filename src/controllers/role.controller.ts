import { Request, Response } from 'express';
import * as roleService from '../services/role.service';
import { bodyOf, optionalKhmerName, optionalString, optionalStringArray, required } from '../utils/validate';

// Role names may contain digits (e.g. "Grade 12 Exam Officer"), so only Khmer script is enforced for khmerName
const latinNameOf = (value: unknown) => optionalString(value, 'latinName', 60);

// GET /api/v1/permissions — catalogue grouped by module
export async function listPermissions(_req: Request, res: Response) {
  res.json({ status: 'success', data: await roleService.listPermissions() });
}

// GET /api/v1/roles
export async function list(_req: Request, res: Response) {
  res.json({ status: 'success', data: await roleService.listRoles() });
}

// GET /api/v1/roles/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await roleService.getRole(req.params.id) });
}

// POST /api/v1/roles  { khmerName, latinName, permissionCodes: [...] }
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const role = await roleService.createRole(req.user!.permissions, {
    khmerName: required(optionalKhmerName(body.khmerName), 'khmerName'),
    latinName: required(latinNameOf(body.latinName), 'latinName'),
    permissionCodes: required(optionalStringArray(body.permissionCodes, 'permissionCodes'), 'permissionCodes'),
  });
  res.status(201).json({ status: 'success', data: role });
}

// PATCH /api/v1/roles/:id  { khmerName?, latinName? } — custom roles only
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const role = await roleService.updateRole(req.params.id, {
    khmerName: optionalKhmerName(body.khmerName),
    latinName: latinNameOf(body.latinName),
  });
  res.json({ status: 'success', data: role });
}

// PUT /api/v1/roles/:id/permissions  { permissionCodes: [...] } — replaces the set; custom roles only
export async function setPermissions(req: Request<{ id: string }>, res: Response) {
  const codes = required(optionalStringArray(bodyOf(req).permissionCodes, 'permissionCodes'), 'permissionCodes');
  res.json({ status: 'success', data: await roleService.setRolePermissions(req.user!.permissions, req.params.id, codes) });
}

// DELETE /api/v1/roles/:id — custom roles not assigned to any user
export async function remove(req: Request<{ id: string }>, res: Response) {
  await roleService.deleteRole(req.params.id);
  res.status(204).end();
}
