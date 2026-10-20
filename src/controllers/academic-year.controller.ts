import { Request, Response } from 'express';
import { AcademicYearStatus } from '../generated/prisma/client';
import * as academicYearService from '../services/academic-year.service';
import { bodyOf, optionalDate, optionalEnum, optionalString, queryString, required } from '../utils/validate';

const STATUSES = Object.values(AcademicYearStatus);

// GET /api/v1/academic-years?status=ACTIVE
export async function list(req: Request, res: Response) {
  const status = optionalEnum(queryString(req.query.status, 'status'), 'status', STATUSES);
  res.json({ status: 'success', data: await academicYearService.listAcademicYears({ status }) });
}

// GET /api/v1/academic-years/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await academicYearService.getAcademicYear(req.params.id) });
}

// POST /api/v1/academic-years
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const year = await academicYearService.createAcademicYear({
    name: required(optionalString(body.name, 'name'), 'name'),
    startDate: required(optionalDate(body.startDate, 'startDate'), 'startDate'),
    endDate: required(optionalDate(body.endDate, 'endDate'), 'endDate'),
    status: optionalEnum(body.status, 'status', STATUSES),
  });
  res.status(201).json({ status: 'success', data: year });
}

// PATCH /api/v1/academic-years/:id
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const year = await academicYearService.updateAcademicYear(req.params.id, {
    name: optionalString(body.name, 'name'),
    startDate: optionalDate(body.startDate, 'startDate'),
    endDate: optionalDate(body.endDate, 'endDate'),
    status: optionalEnum(body.status, 'status', STATUSES),
  });
  res.json({ status: 'success', data: year });
}

// DELETE /api/v1/academic-years/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await academicYearService.deleteAcademicYear(req.params.id);
  res.status(204).end();
}
