import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { PERMISSIONS } from '../constants/permissions';
import * as gradingService from '../services/grading.service';
import * as resultsService from '../services/results.service';
import { bodyOf, optionalScore, optionalString, queryString, required } from '../utils/validate';

const MAX_COMPONENTS = 50;

// components: [{ componentId, score }]; whether they're required depends on the month's rules (service)
function parseComponents(value: unknown): gradingService.ComponentScoreInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_COMPONENTS) {
    throw Errors.INVALID_FIELD('components', `must be an array of at most ${MAX_COMPONENTS} { componentId, score } objects`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw Errors.INVALID_FIELD(`components[${i}]`, 'must be an object { componentId, score }');
    const entry = item as Record<string, unknown>;
    return {
      componentId: required(optionalString(entry.componentId, `components[${i}].componentId`), `components[${i}].componentId`),
      score: required(optionalScore(entry.score, `components[${i}].score`), `components[${i}].score`),
    };
  });
}

// POST /api/v1/scores/subject
// Body: { studentId, subjectId, assessmentPeriodId, classSectionId?, totalScoreAchieved?, components?: [{ componentId, score }] }
// Send totalScoreAchieved when the subject is scored directly that month, components when it is component-based.
// Sending again corrects the score. 201 when first recorded, 200 when updated.
// Only the teacher assigned to the subject in the student's class may do this (403 otherwise), unless they hold
// ENTER_ANY_SCORES. classSectionId is optional; when sent it must be the student's class.
export async function recordSubjectScore(req: Request, res: Response) {
  const body = bodyOf(req);
  const actor = { staffProfileId: req.user!.staffProfileId, canEnterAnyScore: req.user!.permissions.includes(PERMISSIONS.SCORE.ENTER_ANY) };
  const { created, result } = await gradingService.recordSubjectScore(actor, {
    studentId: required(optionalString(body.studentId, 'studentId'), 'studentId'),
    subjectId: required(optionalString(body.subjectId, 'subjectId'), 'subjectId'),
    assessmentPeriodId: required(optionalString(body.assessmentPeriodId, 'assessmentPeriodId'), 'assessmentPeriodId'),
    classSectionId: optionalString(body.classSectionId, 'classSectionId'),
    totalScoreAchieved: optionalScore(body.totalScoreAchieved, 'totalScoreAchieved'),
    components: parseComponents(body.components),
  });
  res.status(created ? 201 : 200).json({ status: 'success', data: result });
}

// GET /api/v1/scores/subject-sheet?classSectionId=&subjectId=&assessmentPeriodId=
// The scores already entered for one subject in one class and period, with the period's rules for it and
// whether the sheet can still be edited (lockReason). Same scope as recording a score.
export async function subjectSheet(req: Request, res: Response) {
  const actor = { staffProfileId: req.user!.staffProfileId, canEnterAnyScore: req.user!.permissions.includes(PERMISSIONS.SCORE.ENTER_ANY) };
  const sheet = await gradingService.getSubjectScoreSheet(
    actor,
    required(queryString(req.query.classSectionId, 'classSectionId'), 'classSectionId'),
    required(queryString(req.query.subjectId, 'subjectId'), 'subjectId'),
    required(queryString(req.query.assessmentPeriodId, 'assessmentPeriodId'), 'assessmentPeriodId'),
  );
  res.json({ status: 'success', data: sheet });
}

// POST /api/v1/scores/results/calculate — { classSectionId, assessmentPeriodId }
// Calculates every active student's total, average, mention and class rank for the period (needed for report
// cards). Refused while a score is missing. CALCULATE_RESULTS: homeroom class only; CALCULATE_ANY_RESULTS: any class.
export async function calculateResults(req: Request, res: Response) {
  const body = bodyOf(req);
  const actor = { staffProfileId: req.user!.staffProfileId, canCalculateAny: req.user!.permissions.includes(PERMISSIONS.RESULT.CALCULATE_ANY) };
  const result = await resultsService.calculateResults(
    actor,
    required(optionalString(body.classSectionId, 'classSectionId'), 'classSectionId'),
    required(optionalString(body.assessmentPeriodId, 'assessmentPeriodId'), 'assessmentPeriodId'),
  );
  res.json({ status: 'success', data: result });
}

// PATCH /api/v1/scores/results/remarks — { assessmentPeriodId, studentId, remarks } (null clears)
// The homeroom teacher's comment on the report card; needs calculated results and an open period.
export async function updateRemarks(req: Request, res: Response) {
  const body = bodyOf(req);
  const actor = { staffProfileId: req.user!.staffProfileId, canCalculateAny: req.user!.permissions.includes(PERMISSIONS.RESULT.CALCULATE_ANY) };
  const remarks = body.remarks === null ? null : required(optionalString(body.remarks, 'remarks', 500), 'remarks');
  const result = await resultsService.updateRemarks(
    actor,
    required(optionalString(body.assessmentPeriodId, 'assessmentPeriodId'), 'assessmentPeriodId'),
    required(optionalString(body.studentId, 'studentId'), 'studentId'),
    remarks,
  );
  res.json({ status: 'success', data: result });
}
