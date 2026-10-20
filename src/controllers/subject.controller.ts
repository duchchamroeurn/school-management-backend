import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import * as subjectService from '../services/subject.service';
import {
  bodyOf,
  optionalBoolean,
  optionalCode,
  optionalKhmerName,
  optionalLatinName,
  optionalStringArray,
  queryBoolean,
  queryString,
  required,
} from '../utils/validate';

// GET /api/v1/subjects?search=&gradeId=&isCoreSubject=
export async function list(req: Request, res: Response) {
  const subjects = await subjectService.listSubjects({
    search: queryString(req.query.search, 'search'),
    gradeId: queryString(req.query.gradeId, 'gradeId'),
    isCoreSubject: queryBoolean(req.query.isCoreSubject, 'isCoreSubject'),
  });
  res.json({ status: 'success', data: subjects });
}

// GET /api/v1/subjects/:id
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await subjectService.getSubject(req.params.id) });
}

// POST /api/v1/subjects
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const subject = await subjectService.createSubject({
    code: required(optionalCode(body.code), 'code'),
    khmerName: required(optionalKhmerName(body.khmerName), 'khmerName'),
    latinName: required(optionalLatinName(body.latinName), 'latinName'),
    isCoreSubject: optionalBoolean(body.isCoreSubject, 'isCoreSubject'),
  });
  res.status(201).json({ status: 'success', data: subject });
}

// PATCH /api/v1/subjects/:id — code cannot be changed
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const subject = await subjectService.updateSubject(req.params.id, {
    khmerName: optionalKhmerName(body.khmerName),
    latinName: optionalLatinName(body.latinName),
    isCoreSubject: optionalBoolean(body.isCoreSubject, 'isCoreSubject'),
  });
  res.json({ status: 'success', data: subject });
}

// DELETE /api/v1/subjects/:id
export async function remove(req: Request<{ id: string }>, res: Response) {
  await subjectService.deleteSubject(req.params.id);
  res.status(204).end();
}

// POST /api/v1/subjects/:id/grades  { gradeIds: [...] }
export async function assignToGrades(req: Request<{ id: string }>, res: Response) {
  const gradeIds = required(optionalStringArray(bodyOf(req).gradeIds, 'gradeIds'), 'gradeIds');
  if (!gradeIds.length) {
    throw Errors.GRADE_IDS_REQUIRED();
  }
  res.json({ status: 'success', data: await subjectService.assignToGrades(req.params.id, gradeIds) });
}

// DELETE /api/v1/subjects/:id/grades/:gradeId
export async function unassignFromGrade(req: Request<{ id: string; gradeId: string }>, res: Response) {
  res.json({ status: 'success', data: await subjectService.unassignFromGrade(req.params.id, req.params.gradeId) });
}
