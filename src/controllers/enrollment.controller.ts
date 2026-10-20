import { Request, Response } from 'express';
import * as enrollmentService from '../services/enrollment.service';
import * as promotionService from '../services/promotion.service';
import { bodyOf, optionalBoolean, optionalString, optionalStringArray, pagination, queryString, required } from '../utils/validate';

// GET /api/v1/enrollments?academicYearId=&classSectionId=&studentId=&page=&pageSize=
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const { items, total } = await enrollmentService.listEnrollments({
    academicYearId: queryString(req.query.academicYearId, 'academicYearId'),
    classSectionId: queryString(req.query.classSectionId, 'classSectionId'),
    studentId: queryString(req.query.studentId, 'studentId'),
    skip,
    take,
  });
  res.json({ status: 'success', data: items, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

// GET /api/v1/enrollments/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await enrollmentService.getEnrollment(req.params.id) });
}

// POST /api/v1/enrollments — new admission into a class
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const enrollment = await enrollmentService.enrollStudentInClass(
    required(optionalString(body.studentId, 'studentId'), 'studentId'),
    required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
    required(optionalString(body.academicYearId, 'academicYearId'), 'academicYearId'),
  );
  res.status(201).json({ status: 'success', data: enrollment });
}

// PATCH /api/v1/enrollments/:id — transfer to another class section in the same year
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const enrollment = await enrollmentService.transferEnrollment(
    req.params.id,
    required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
  );
  res.json({ status: 'success', data: enrollment });
}

// DELETE /api/v1/enrollments/:id — mistaken enrollments only
export async function remove(req: Request<{ id: string }>, res: Response) {
  await enrollmentService.deleteEnrollment(req.params.id);
  res.status(204).end();
}

// GET /api/v1/class-sections/:id/roster
export async function roster(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await enrollmentService.getClassRoster(req.params.id) });
}

// POST /api/v1/class-sections/:id/promote — end-of-year promotion of the whole class
// Body: { promotedClassSectionId?, repeatingClassSectionId?, repeatingStudentIds?: [], excludedStudentIds?: [], dryRun?: false }
// Everyone active in the class is PROMOTED unless listed as repeating or excluded; in the top grade they graduate.
// All-or-nothing. dryRun: true returns the same result without changing anything (200); a real run returns 201.
export async function promote(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const dryRun = optionalBoolean(body.dryRun, 'dryRun') ?? false;
  const result = await promotionService.promoteClass({
    sourceClassSectionId: req.params.id,
    promotedClassSectionId: optionalString(body.promotedClassSectionId, 'promotedClassSectionId'),
    repeatingClassSectionId: optionalString(body.repeatingClassSectionId, 'repeatingClassSectionId'),
    repeatingStudentIds: optionalStringArray(body.repeatingStudentIds, 'repeatingStudentIds') ?? [],
    excludedStudentIds: optionalStringArray(body.excludedStudentIds, 'excludedStudentIds') ?? [],
    dryRun,
  });
  res.status(dryRun ? 200 : 201).json({ status: 'success', data: result });
}
