import { Request, Response } from 'express';
import * as classSectionService from '../services/class-section.service';
import { Shift } from '../generated/prisma/client';
import { bodyOf, nullableString, optionalEnum, optionalInt, optionalString, queryString, required } from '../utils/validate';

const SHIFTS = Object.values(Shift);

const capacityOf = (value: unknown) => optionalInt(value, 'maxCapacity', 1, classSectionService.MAX_CAPACITY_LIMIT);

// GET /api/v1/class-sections?academicYearId=…&gradeId=…
export async function list(req: Request, res: Response) {
  const classSections = await classSectionService.listClassSections({
    academicYearId: queryString(req.query.academicYearId, 'academicYearId'),
    gradeId: queryString(req.query.gradeId, 'gradeId'),
  });
  res.json({ status: 'success', data: classSections });
}

// GET /api/v1/class-sections/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await classSectionService.getClassSection(req.params.id) });
}

// POST /api/v1/class-sections
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const classSection = await classSectionService.createClassSection({
    sectionName: required(optionalString(body.sectionName, 'sectionName', 10), 'sectionName'),
    maxCapacity: required(capacityOf(body.maxCapacity), 'maxCapacity'),
    gradeId: required(optionalString(body.gradeId, 'gradeId'), 'gradeId'),
    academicYearId: required(optionalString(body.academicYearId, 'academicYearId'), 'academicYearId'),
    homeroomTeacherId: nullableString(body.homeroomTeacherId, 'homeroomTeacherId'),
    shift: optionalEnum(body.shift, 'shift', SHIFTS),
    roomId: nullableString(body.roomId, 'roomId'),
  });
  res.status(201).json({ status: 'success', data: classSection });
}

// PATCH /api/v1/class-sections/:id — send homeroomTeacherId: null to remove the homeroom teacher
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const classSection = await classSectionService.updateClassSection(req.params.id, {
    sectionName: optionalString(body.sectionName, 'sectionName', 10),
    maxCapacity: capacityOf(body.maxCapacity),
    homeroomTeacherId: nullableString(body.homeroomTeacherId, 'homeroomTeacherId'),
    shift: optionalEnum(body.shift, 'shift', SHIFTS),
    roomId: nullableString(body.roomId, 'roomId'),
  });
  res.json({ status: 'success', data: classSection });
}

// DELETE /api/v1/class-sections/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await classSectionService.deleteClassSection(req.params.id);
  res.status(204).end();
}
