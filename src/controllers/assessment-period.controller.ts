import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import * as periodService from '../services/assessment-period.service';
import { bodyOf, optionalBoolean, optionalDate, optionalScore, optionalString, queryString, required } from '../utils/validate';

const MAX_COMPONENTS = 20;

// A date that may be sent as null to clear it
const nullableDate = (value: unknown, field: string) => (value === null ? null : optionalDate(value, field));

// GET /api/v1/assessment-periods?academicYearId= — in calendar order (defaults to the ACTIVE year)
export async function list(req: Request, res: Response) {
  res.json({ status: 'success', data: await periodService.listPeriods(queryString(req.query.academicYearId, 'academicYearId')) });
}

// GET /api/v1/assessment-periods/:id — with every subject's scoring rules
export async function get(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await periodService.getPeriod(req.params.id) });
}

// POST /api/v1/assessment-periods — { academicYearId, name, startDate, endDate, scoreEntryDeadline? } (dates YYYY-MM-DD)
export async function create(req: Request, res: Response) {
  const body = bodyOf(req);
  const period = await periodService.createPeriod({
    academicYearId: required(optionalString(body.academicYearId, 'academicYearId'), 'academicYearId'),
    name: required(optionalString(body.name, 'name', 50), 'name'),
    startDate: required(optionalDate(body.startDate, 'startDate'), 'startDate'),
    endDate: required(optionalDate(body.endDate, 'endDate'), 'endDate'),
    scoreEntryDeadline: nullableDate(body.scoreEntryDeadline, 'scoreEntryDeadline'),
  });
  res.status(201).json({ status: 'success', data: period });
}

// PATCH /api/v1/assessment-periods/:id — { name?, startDate?, endDate?, scoreEntryDeadline? (null = no deadline) }
export async function update(req: Request<{ id: string }>, res: Response) {
  const body = bodyOf(req);
  const period = await periodService.updatePeriod(req.params.id, {
    name: optionalString(body.name, 'name', 50),
    startDate: optionalDate(body.startDate, 'startDate'),
    endDate: optionalDate(body.endDate, 'endDate'),
    scoreEntryDeadline: nullableDate(body.scoreEntryDeadline, 'scoreEntryDeadline'),
  });
  res.json({ status: 'success', data: period });
}

// DELETE /api/v1/assessment-periods/:id — only before any score or result exists
export async function remove(req: Request<{ id: string }>, res: Response) {
  await periodService.deletePeriod(req.params.id);
  res.status(204).end();
}

// POST /api/v1/assessment-periods/:id/lock and /unlock
export async function lock(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await periodService.setLocked(req.params.id, true) });
}
export async function unlock(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await periodService.setLocked(req.params.id, false) });
}

// PUT /api/v1/assessment-periods/:id/subjects/:subjectId
// { maxTotalScore, isComponentBased?, components?: [{ name, maxScore }] } — components must add up to maxTotalScore
export async function setSubjectRules(req: Request<{ id: string; subjectId: string }>, res: Response) {
  const body = bodyOf(req);
  if (body.components !== undefined && (!Array.isArray(body.components) || body.components.length > MAX_COMPONENTS)) {
    throw Errors.INVALID_FIELD('components', `must be an array of at most ${MAX_COMPONENTS} { name, maxScore } objects`);
  }
  const components = ((body.components as unknown[] | undefined) ?? []).map((item, i) => {
    if (typeof item !== 'object' || item === null) throw Errors.INVALID_FIELD(`components[${i}]`, 'must be an object { name, maxScore }');
    const c = item as Record<string, unknown>;
    return {
      name: required(optionalString(c.name, `components[${i}].name`, 50), `components[${i}].name`),
      maxScore: required(optionalScore(c.maxScore, `components[${i}].maxScore`), `components[${i}].maxScore`),
    };
  });
  const config = await periodService.setSubjectRules(req.params.id, req.params.subjectId, {
    maxTotalScore: required(optionalScore(body.maxTotalScore, 'maxTotalScore'), 'maxTotalScore'),
    isComponentBased: optionalBoolean(body.isComponentBased, 'isComponentBased') ?? components.length > 0,
    components,
  });
  res.json({ status: 'success', data: config });
}

// DELETE /api/v1/assessment-periods/:id/subjects/:subjectId — only before any score was entered under the rules
export async function removeSubjectRules(req: Request<{ id: string; subjectId: string }>, res: Response) {
  await periodService.removeSubjectRules(req.params.id, req.params.subjectId);
  res.status(204).end();
}

// POST /api/v1/assessment-periods/:id/copy-rules — { fromAssessmentPeriodId }
export async function copyRules(req: Request<{ id: string }>, res: Response) {
  const from = required(optionalString(bodyOf(req).fromAssessmentPeriodId, 'fromAssessmentPeriodId'), 'fromAssessmentPeriodId');
  res.json({ status: 'success', data: await periodService.copyRules(req.params.id, from) });
}
