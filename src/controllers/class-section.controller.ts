import { Request, Response } from 'express';
import { CLASS_SCHEDULES } from '../constants/class-schedule';
import { Errors } from '../constants/errors';
import * as classSectionService from '../services/class-section.service';
import { bodyOf, nullableString, optionalEnum, optionalInt, optionalString, queryString, required } from '../utils/validate';

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

// schedule: FULL_DAY (the default for a new class), or MORNING / AFTERNOON for a half-day class. The old `shift`
// field is refused with a pointer, rather than ignored, so an outdated client notices.
function scheduleOf(body: Record<string, unknown>) {
  if ('shift' in body) throw Errors.INVALID_FIELD('shift', 'has been replaced by schedule: FULL_DAY, MORNING or AFTERNOON');
  return optionalEnum(body.schedule, 'schedule', CLASS_SCHEDULES);
}

// POST /api/v1/class-sections — schedule left out: a full-day class
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const classSection = await classSectionService.createClassSection({
    sectionName: required(optionalString(body.sectionName, 'sectionName', 10), 'sectionName'),
    maxCapacity: required(capacityOf(body.maxCapacity), 'maxCapacity'),
    gradeId: required(optionalString(body.gradeId, 'gradeId'), 'gradeId'),
    academicYearId: required(optionalString(body.academicYearId, 'academicYearId'), 'academicYearId'),
    homeroomTeacherId: nullableString(body.homeroomTeacherId, 'homeroomTeacherId'),
    schedule: scheduleOf(body),
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
    schedule: scheduleOf(body),
    roomId: nullableString(body.roomId, 'roomId'),
  });
  res.json({ status: 'success', data: classSection });
}

// DELETE /api/v1/class-sections/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await classSectionService.deleteClassSection(req.params.id);
  res.status(204).end();
}
