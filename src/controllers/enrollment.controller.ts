import { Request, Response } from 'express';
import * as enrollmentService from '../services/enrollment.service';
import { bodyOf, optionalString, pagination, queryString, required } from '../utils/validate';

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
