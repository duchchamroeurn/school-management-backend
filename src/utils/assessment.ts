// Validation for MoEYS grading rules (SubjectAssessmentConfig + its SubjectComponents).
//
// A config that is component-based scores a subject as the sum of its components, so the components'
// maxScore values must add up to exactly the config's maxTotalScore. Otherwise a student with full
// marks on every component would not reach (or would exceed) the subject's maximum.
//
//   assertConfigComponentsValid({ maxTotalScore: 100, isComponentBased: true, components })  // before writing
//   await assertStoredConfigValid(tx, configId)                                              // after writing, same tx
import { Errors } from '../constants/errors';
import { Prisma } from '../generated/prisma/client';

export interface ComponentRule {
  name: string;
  maxScore: number;
}

export interface AssessmentConfigRule {
  maxTotalScore: number;
  isComponentBased: boolean;
  components: ComponentRule[];
}

// Scores use at most two decimals (e.g. 12.5, 7.25). Comparing whole hundredths avoids floating-point
// noise such as 0.1 + 0.2 !== 0.3, while still requiring the sum to be exact.
const hundredths = (value: number) => Math.round(value * 100);

export const sumComponentMaxScores = (components: ComponentRule[]) =>
  components.reduce((sum, c) => sum + hundredths(c.maxScore), 0) / 100;

/** Throws a 400 HttpError describing the first rule the config breaks. */
export function assertConfigComponentsValid(config: AssessmentConfigRule) {
  if (!Number.isFinite(config.maxTotalScore) || config.maxTotalScore <= 0) {
    throw Errors.MAX_TOTAL_SCORE_INVALID();
  }

  if (!config.isComponentBased) {
    // A single score is entered directly; components would never be used
    if (config.components.length > 0) throw Errors.COMPONENTS_NOT_ALLOWED();
    return;
  }

  if (config.components.length === 0) throw Errors.COMPONENTS_REQUIRED();

  const seen = new Set<string>();
  for (const component of config.components) {
    if (!Number.isFinite(component.maxScore) || component.maxScore <= 0) {
      throw Errors.COMPONENT_MAX_SCORE_INVALID(component.name);
    }
    const key = component.name.trim().toLowerCase();
    if (seen.has(key)) throw Errors.DUPLICATE_COMPONENT_NAME(component.name);
    seen.add(key);
  }

  const componentTotal = sumComponentMaxScores(config.components);
  if (hundredths(componentTotal) !== hundredths(config.maxTotalScore)) {
    throw Errors.COMPONENT_TOTAL_MISMATCH(config.maxTotalScore, componentTotal);
  }
}

/**
 * Loads a stored config with its components and validates it. Call it inside the transaction that
 * changes the config or its components, after the writes, so an invalid combination is rolled back.
 */
export async function assertStoredConfigValid(db: Prisma.TransactionClient, subjectAssessmentConfigId: string) {
  const config = await db.subjectAssessmentConfig.findUnique({
    where: { id: subjectAssessmentConfigId },
    include: { components: { select: { name: true, maxScore: true } } },
  });
  if (!config) throw Errors.SUBJECT_ASSESSMENT_CONFIG_NOT_FOUND();
  assertConfigComponentsValid(config);
  return config;
}
