import { Request, Response } from 'express';
import { Gender } from '../generated/prisma/client';
import * as staffService from '../services/staff.service';
import {
  bodyOf,
  nullablePhone,
  nullableTelegramHandle,
  optionalDate,
  optionalDocumentNumber,
  optionalEnum,
  optionalKhmerName,
  optionalLatinName,
  optionalString,
  pagination,
  queryString,
  required,
} from '../utils/validate';

const GENDERS = Object.values(Gender);

// GET /api/v1/staff?search=&gender=&page=&pageSize=
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await staffService.listStaff({
    search: queryString(req.query.search, 'search'),
    gender: optionalEnum(queryString(req.query.gender, 'gender'), 'gender', GENDERS),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/staff/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await staffService.getStaff(req.params.id) });
}

// POST /api/v1/staff
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const staff = await staffService.createStaff({
    nationalIdNo: required(optionalDocumentNumber(body.nationalIdNo, 'nationalIdNo'), 'nationalIdNo'),
    khmerName: required(optionalKhmerName(body.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(body.latinName), 'latinName'),
    gender: required(optionalEnum(body.gender, 'gender', GENDERS), 'gender'),
    phone: nullablePhone(body.phone),
    telegramHandle: nullableTelegramHandle(body.telegramHandle),
    hireDate: required(optionalDate(body.hireDate, 'hireDate'), 'hireDate'),
  });
  res.status(201).json({ status: 'success', data: staff });
}

// PATCH /api/v1/staff/:id
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const staff = await staffService.updateStaff(req.params.id, {
    nationalIdNo: optionalDocumentNumber(body.nationalIdNo, 'nationalIdNo'),
    khmerName: optionalKhmerName(body.khmerName),
    latinName: optionalLatinName(body.latinName),
    gender: optionalEnum(body.gender, 'gender', GENDERS),
    phone: nullablePhone(body.phone),
    telegramHandle: nullableTelegramHandle(body.telegramHandle),
    hireDate: optionalDate(body.hireDate, 'hireDate'),
  });
  res.json({ status: 'success', data: staff });
}

// DELETE /api/v1/staff/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await staffService.deleteStaff(req.params.id);
  res.status(204).end();
}

// POST /api/v1/staff/assign-homeroom  { staffId, classSectionId, academicYear? }  (academicYear = name, e.g. "2026-2027")
export async function assignHomeroom(req: Request, res: Response) {
  const body = bodyOf(req);
  const result = await staffService.assignHomeroom({
    staffId: required(optionalString(body.staffId, 'staffId'), 'staffId'),
    classSectionId: required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
    academicYearName: optionalString(body.academicYear, 'academicYear'),
  });
  res.json({ status: 'success', data: result });
}
