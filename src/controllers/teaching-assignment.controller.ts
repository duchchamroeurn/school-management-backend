import { Request, Response } from 'express';
import * as teachingAssignmentService from '../services/teaching-assignment.service';
import { bodyOf, optionalString, queryString, required } from '../utils/validate';

// GET /api/v1/teaching-assignments?staffId=&subjectId=&classSectionId=&academicYearId=
export async function list(req: Request, res: Response) {
  const assignments = await teachingAssignmentService.listTeachingAssignments({
    staffId: queryString(req.query.staffId, 'staffId'),
    subjectId: queryString(req.query.subjectId, 'subjectId'),
    classSectionId: queryString(req.query.classSectionId, 'classSectionId'),
    academicYearId: queryString(req.query.academicYearId, 'academicYearId'),
  });
  res.json({ status: 'success', data: assignments });
}

// GET /api/v1/teaching-assignments/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await teachingAssignmentService.getTeachingAssignment(req.params.id) });
}

// POST /api/v1/teaching-assignments — { staffId, subjectId, classSectionId }
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const assignment = await teachingAssignmentService.createTeachingAssignment({
    staffId: required(optionalString(body.staffId, 'staffId'), 'staffId'),
    subjectId: required(optionalString(body.subjectId, 'subjectId'), 'subjectId'),
    classSectionId: required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
  });
  res.status(201).json({ status: 'success', data: assignment });
}

// PATCH /api/v1/teaching-assignments/:id — { staffId }: hand the subject in this class to another teacher
export async function update(req: Request<{ id: string }>, res: Response) {
  const staffId = required(optionalString(bodyOf(req).staffId, 'staffId'), 'staffId');
  res.json({ status: 'success', data: await teachingAssignmentService.reassignTeacher(req.params.id, staffId) });
}

// DELETE /api/v1/teaching-assignments/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await teachingAssignmentService.deleteTeachingAssignment(req.params.id);
  res.status(204).end();
}

// GET /api/v1/me/teaching-assignments?academicYear=2026-2027 (defaults to the ACTIVE year)
export async function listOwn(req: Request, res: Response) {
  const academicYear = queryString(req.query.academicYear, 'academicYear');
  res.json({ status: 'success', data: await teachingAssignmentService.listOwnTeachingAssignments(req.user!.id, academicYear) });
}
