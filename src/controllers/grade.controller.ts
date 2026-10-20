import { Request, Response } from 'express';
import * as gradeService from '../services/grade.service';
import { bodyOf, optionalInt, required } from '../utils/validate';

const gradeNumberOf = (value: unknown) => optionalInt(value, 'gradeNumber', gradeService.MIN_GRADE, gradeService.MAX_GRADE);

// GET /api/v1/grades
export async function list(_req: Request, res: Response) {
  res.json({ status: 'success', data: await gradeService.listGrades() });
}

// GET /api/v1/grades/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await gradeService.getGrade(req.params.id) });
}

// POST /api/v1/grades
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const grade = await gradeService.createGrade({ gradeNumber: required(gradeNumberOf(body.gradeNumber), 'gradeNumber') });
  res.status(201).json({ status: 'success', data: grade });
}

// PATCH /api/v1/grades/:id
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const grade = await gradeService.updateGrade(req.params.id, { gradeNumber: gradeNumberOf(body.gradeNumber) });
  res.json({ status: 'success', data: grade });
}

// DELETE /api/v1/grades/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await gradeService.deleteGrade(req.params.id);
  res.status(204).end();
}
