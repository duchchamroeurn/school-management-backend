import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { GuardianRelationship } from '../generated/prisma/client';
import * as guardianService from '../services/guardian.service';
import {
  bodyOf,
  nullablePhone,
  nullableString,
  nullableTelegramHandle,
  optionalBoolean,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  optionalString,
  pagination,
  queryString,
  required,
} from '../utils/validate';

const RELATIONSHIPS = Object.values(GuardianRelationship);

// Fields of a guardian; `required` decides between create (names required) and update (all optional)
function guardianFields(body: Record<string, unknown>, prefix = '') {
  return {
    khmerName: optionalKhmerName(body.khmerName, `${prefix}khmerName`),
    latinName: optionalLatinName(body.latinName, `${prefix}latinName`),
    phone: nullablePhone(body.phone, `${prefix}phone`),
    telegramHandle: nullableTelegramHandle(body.telegramHandle, `${prefix}telegramHandle`),
    occupation: nullableString(body.occupation, `${prefix}occupation`),
    address: nullableString(body.address, `${prefix}address`),
  };
}

function newGuardian(body: Record<string, unknown>, prefix = ''): guardianService.GuardianInput {
  const fields = guardianFields(body, prefix);
  return { ...fields, khmerName: required(fields.khmerName, `${prefix}khmerName`), latinName: required(fields.latinName, `${prefix}latinName`) };
}

// GET /api/v1/guardians?search=&page=&pageSize= — search by Khmer or Latin name, or phone number
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await guardianService.listGuardians({ search: queryString(req.query.search, 'search'), skip, take });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/guardians/:id — with the students they are guardian of
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await guardianService.getGuardian(req.params.id) });
}

// POST /api/v1/guardians — { khmerName, latinName, phone?, telegramHandle?, occupation?, address? }
export async function create(req: Request, res: Response) {
  res.status(201).json({ status: 'success', data: await guardianService.createGuardian(newGuardian(bodyOf(req))) });
}

// PATCH /api/v1/guardians/:id — changes apply to every child of this guardian
export async function update(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await guardianService.updateGuardian(req.params.id, guardianFields(bodyOf(req))) });
}

// DELETE /api/v1/guardians/:id — only when no student is linked
export async function remove(req: Request<{ id: string }>, res: Response) {
  await guardianService.deleteGuardian(req.params.id);
  res.status(204).end();
}

// GET /api/v1/students/:id/guardians — primary contact first
export async function listForStudent(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await guardianService.listStudentGuardians(req.params.id) });
}

// POST /api/v1/students/:id/guardians
// { relationship, isPrimaryContact?, guardianId } links an existing guardian (e.g. a sibling's parent);
// { relationship, isPrimaryContact?, guardian: { khmerName, latinName, phone?, … } } adds a new one.
// The student's first guardian is always the primary contact.
export async function linkToStudent(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const guardian = body.guardian;
  // Checked before the guardian's fields, so the client hears the real problem first
  if (guardian !== undefined && body.guardianId !== undefined) throw Errors.GUARDIAN_INPUT_AMBIGUOUS();
  if (guardian !== undefined && (typeof guardian !== 'object' || guardian === null || Array.isArray(guardian))) {
    throw Errors.INVALID_FIELD('guardian', 'must be an object { khmerName, latinName, phone?, … }');
  }
  const link = await guardianService.linkGuardian(req.params.id, {
    guardianId: optionalString(body.guardianId, 'guardianId'),
    guardian: guardian === undefined ? undefined : newGuardian(guardian as Record<string, unknown>, 'guardian.'),
    relationship: required(optionalEnum(body.relationship, 'relationship', RELATIONSHIPS), 'relationship'),
    isPrimaryContact: optionalBoolean(body.isPrimaryContact, 'isPrimaryContact'),
  });
  res.status(201).json({ status: 'success', data: link });
}

// PATCH /api/v1/students/:id/guardians/:guardianId — { relationship?, isPrimaryContact? }
export async function updateLink(req: Request<{ id: string; guardianId: string }>, res: Response) {
  const body = bodyOf(req);
  const link = await guardianService.updateGuardianLink(req.params.id, req.params.guardianId, {
    relationship: optionalEnum(body.relationship, 'relationship', RELATIONSHIPS),
    isPrimaryContact: optionalBoolean(body.isPrimaryContact, 'isPrimaryContact'),
  });
  res.json({ status: 'success', data: link });
}

// DELETE /api/v1/students/:id/guardians/:guardianId — the guardian record itself is kept
export async function unlinkFromStudent(req: Request<{ id: string; guardianId: string }>, res: Response) {
  await guardianService.unlinkGuardian(req.params.id, req.params.guardianId);
  res.status(204).end();
}
