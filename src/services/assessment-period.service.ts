// Assessment periods (a month such as "January", or an exam period such as "Semester 1") and how each subject is
// scored in them (SubjectAssessmentConfig + SubjectComponents). This is what score entry, results and report
// cards are built on.
//
// - A locked period is final: nothing about it, its rules or its scores can change until it is unlocked.
// - A subject's rules freeze once any score was entered under them: the scores were checked against those
//   maximums. Rule changes take a row lock on the period, the same row score entry share-locks, so a score
//   can't slip in while rules are being changed.
import { Errors } from '../constants/errors';
import { AcademicYearStatus, Prisma } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { assertConfigComponentsValid, assertStoredConfigValid, ComponentRule } from '../utils/assessment';
import { isoDate } from '../utils/dates';
import { audit, scalars } from './audit.service';

export interface PeriodInput {
  academicYearId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  scoreEntryDeadline?: Date | null;
}

export interface SubjectRulesInput {
  maxTotalScore: number;
  isComponentBased: boolean;
  components: ComponentRule[]; // empty unless isComponentBased
}

const listInclude = {
  academicYear: { select: { id: true, name: true, status: true } },
  _count: { select: { subjectConfigs: true, results: true } },
} satisfies Prisma.AssessmentPeriodInclude;

const detailInclude = {
  academicYear: { select: { id: true, name: true, status: true } },
  subjectConfigs: {
    include: {
      subject: { select: { id: true, code: true, khmerName: true, latinName: true, isCoreSubject: true } },
      components: { orderBy: { name: 'asc' } },
      _count: { select: { subjectScores: true } },
    },
    orderBy: [{ subject: { isCoreSubject: 'desc' } }, { subject: { code: 'asc' } }],
  },
  _count: { select: { results: true } },
} satisfies Prisma.AssessmentPeriodInclude;

const periodLabel = (p: { name: string; academicYear: { name: string } }) => `${p.name} ${p.academicYear.name}`;
const auditPeriod = (p: { id: string; name: string; academicYear: { name: string } }) =>
  ({ entityType: 'AssessmentPeriod', entityId: p.id, entityLabel: periodLabel(p) }) as const;

const rulesSnapshot = (c: { maxTotalScore: number; isComponentBased: boolean; components: ComponentRule[] }) => ({
  maxTotalScore: c.maxTotalScore,
  isComponentBased: c.isComponentBased,
  components: c.components.map((k) => `${k.name} ${k.maxScore}`).sort(),
});

function assertYearOpen(year: { name: string; status: AcademicYearStatus }) {
  if (year.status === AcademicYearStatus.COMPLETED) throw Errors.ACADEMIC_YEAR_CLOSED(year.name, 'its assessment periods');
}

function assertDates(year: { name: string; startDate: Date; endDate: Date }, p: { startDate: Date; endDate: Date; scoreEntryDeadline?: Date | null }) {
  if (p.endDate < p.startDate) throw Errors.PERIOD_END_BEFORE_START();
  if (p.startDate < year.startDate || p.endDate > year.endDate) {
    throw Errors.PERIOD_OUTSIDE_YEAR(year.name, isoDate(year.startDate), isoDate(year.endDate));
  }
  if (p.scoreEntryDeadline && p.scoreEntryDeadline < p.startDate) throw Errors.DEADLINE_BEFORE_START();
}

const nameTaken = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Loads the period with a row lock (FOR UPDATE) and checks it may still change */
async function lockOpenPeriod(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM assessment_periods WHERE id = ${id} FOR UPDATE`;
  if (!row) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
  const period = await tx.assessmentPeriod.findUniqueOrThrow({ where: { id }, include: { academicYear: true } });
  if (period.isLocked) throw Errors.PERIOD_LOCKED(period.name, period.academicYear.name);
  assertYearOpen(period.academicYear);
  return period;
}

async function scoresUnder(tx: Prisma.TransactionClient, configId: string) {
  const [subjectScores, componentScores] = await Promise.all([
    tx.monthlySubjectScore.count({ where: { subjectAssessmentConfigId: configId } }),
    tx.componentScore.count({ where: { subjectComponent: { subjectAssessmentConfigId: configId } } }),
  ]);
  return subjectScores + componentScores;
}

// ── Periods ───────────────────────────────────────────────────────────────

/** Periods of the given or the ACTIVE academic year, in calendar order */
export async function listPeriods(academicYearId?: string) {
  const year = academicYearId
    ? await prisma.academicYear.findUnique({ where: { id: academicYearId } })
    : await prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } });
  if (!year) throw academicYearId ? Errors.ACADEMIC_YEAR_NOT_FOUND() : Errors.ACADEMIC_YEAR_REQUIRED();
  return prisma.assessmentPeriod.findMany({ where: { academicYearId: year.id }, include: listInclude, orderBy: [{ startDate: 'asc' }, { name: 'asc' }] });
}

/** One period with every subject's scoring rules and how many scores were entered under them */
export async function getPeriod(id: string) {
  const period = await prisma.assessmentPeriod.findUnique({ where: { id }, include: detailInclude });
  if (!period) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
  return period;
}

export async function createPeriod(data: PeriodInput) {
  try {
    return await prisma.$transaction(async (tx) => {
      const year = await tx.academicYear.findUnique({ where: { id: data.academicYearId } });
      if (!year) throw Errors.ACADEMIC_YEAR_NOT_FOUND();
      assertYearOpen(year);
      assertDates(year, data);
      const created = await tx.assessmentPeriod.create({ data, include: listInclude });
      await audit(tx, { ...auditPeriod(created), action: 'ASSESSMENT_PERIOD_CREATED', after: scalars(created) });
      return created;
    });
  } catch (err) {
    if (nameTaken(err)) {
      const year = await prisma.academicYear.findUnique({ where: { id: data.academicYearId } });
      throw Errors.ASSESSMENT_PERIOD_EXISTS(data.name, year?.name ?? '');
    }
    throw err;
  }
}

export async function updatePeriod(id: string, data: Partial<Omit<PeriodInput, 'academicYearId'>>) {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await lockOpenPeriod(tx, id);
      const merged = {
        startDate: data.startDate ?? current.startDate,
        endDate: data.endDate ?? current.endDate,
        scoreEntryDeadline: data.scoreEntryDeadline === undefined ? current.scoreEntryDeadline : data.scoreEntryDeadline,
      };
      assertDates(current.academicYear, merged);
      const updated = await tx.assessmentPeriod.update({ where: { id }, data: { ...merged, name: data.name }, include: listInclude });
      await audit(tx, { ...auditPeriod(updated), action: 'ASSESSMENT_PERIOD_UPDATED', before: scalars(current, ['academicYear']), after: scalars(updated) });
      return updated;
    });
  } catch (err) {
    if (nameTaken(err)) {
      const period = await prisma.assessmentPeriod.findUnique({ where: { id }, include: { academicYear: true } });
      throw Errors.ASSESSMENT_PERIOD_EXISTS(data.name ?? '', period?.academicYear.name ?? '');
    }
    throw err;
  }
}

/** Only a period nobody has scored yet (e.g. created by mistake); its rules are removed with it */
export async function deletePeriod(id: string) {
  await prisma.$transaction(async (tx) => {
    const period = await lockOpenPeriod(tx, id);
    const [scores, results] = await Promise.all([
      tx.monthlySubjectScore.count({ where: { subjectAssessmentConfig: { assessmentPeriodId: id } } }),
      tx.monthlyResult.count({ where: { assessmentPeriodId: id } }),
    ]);
    if (scores || results) throw Errors.PERIOD_HAS_SCORES(periodLabel(period), scores, results);
    await tx.assessmentPeriod.delete({ where: { id } }); // configs and components cascade
    await audit(tx, { ...auditPeriod(period), action: 'ASSESSMENT_PERIOD_DELETED', before: scalars(period, ['academicYear']) });
  });
}

/**
 * Locks (finalises) or reopens a period. Score entry share-locks the period row, so locking waits for any
 * score being saved at that moment and blocks all later ones.
 */
export async function setLocked(id: string, locked: boolean) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM assessment_periods WHERE id = ${id} FOR UPDATE`;
    if (!row) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
    const period = await tx.assessmentPeriod.findUniqueOrThrow({ where: { id }, include: { academicYear: true } });
    assertYearOpen(period.academicYear);
    if (period.isLocked === locked) throw Errors.PERIOD_ALREADY_IN_STATE(periodLabel(period), locked);
    const updated = await tx.assessmentPeriod.update({ where: { id }, data: { isLocked: locked }, include: listInclude });
    await audit(tx, {
      ...auditPeriod(period),
      action: locked ? 'ASSESSMENT_PERIOD_LOCKED' : 'ASSESSMENT_PERIOD_UNLOCKED',
      before: { isLocked: !locked },
      after: { isLocked: locked },
    });
    return updated;
  });
}

// ── A subject's scoring rules in a period ─────────────────────────────────

/** Creates or replaces how a subject is scored in this period (only while no score was entered under it) */
export async function setSubjectRules(periodId: string, subjectId: string, rules: SubjectRulesInput) {
  assertConfigComponentsValid(rules);
  return prisma.$transaction(async (tx) => {
    const period = await lockOpenPeriod(tx, periodId);
    const subject = await tx.subject.findUnique({ where: { id: subjectId } });
    if (!subject) throw Errors.SUBJECT_NOT_FOUND();

    const existing = await tx.subjectAssessmentConfig.findUnique({
      where: { subjectId_assessmentPeriodId: { subjectId, assessmentPeriodId: periodId } },
      include: { components: true },
    });
    if (existing) {
      const scores = await scoresUnder(tx, existing.id);
      if (scores) throw Errors.RULES_HAVE_SCORES(subject.latinName, periodLabel(period), scores);
      await tx.subjectComponent.deleteMany({ where: { subjectAssessmentConfigId: existing.id } });
    }
    const components = { create: rules.components.map((c) => ({ name: c.name.trim(), maxScore: c.maxScore })) };
    const config = existing
      ? await tx.subjectAssessmentConfig.update({
          where: { id: existing.id },
          data: { maxTotalScore: rules.maxTotalScore, isComponentBased: rules.isComponentBased, components },
        })
      : await tx.subjectAssessmentConfig.create({
          data: { subjectId, assessmentPeriodId: periodId, maxTotalScore: rules.maxTotalScore, isComponentBased: rules.isComponentBased, components },
        });
    const saved = await assertStoredConfigValid(tx, config.id);

    await audit(tx, {
      ...auditPeriod(period),
      entityLabel: `${subject.code} — ${periodLabel(period)}`,
      action: 'SUBJECT_RULES_SET',
      before: existing && rulesSnapshot(existing),
      after: rulesSnapshot(saved),
    });
    return tx.subjectAssessmentConfig.findUniqueOrThrow({
      where: { id: config.id },
      include: { subject: { select: { id: true, code: true, khmerName: true, latinName: true } }, components: { orderBy: { name: 'asc' } } },
    });
  });
}

/** Stops scoring a subject in this period (only while no score was entered under it) */
export async function removeSubjectRules(periodId: string, subjectId: string) {
  await prisma.$transaction(async (tx) => {
    const period = await lockOpenPeriod(tx, periodId);
    const config = await tx.subjectAssessmentConfig.findUnique({
      where: { subjectId_assessmentPeriodId: { subjectId, assessmentPeriodId: periodId } },
      include: { subject: true, components: true },
    });
    if (!config) {
      const subject = await tx.subject.findUnique({ where: { id: subjectId } });
      if (!subject) throw Errors.SUBJECT_NOT_FOUND();
      throw Errors.NO_RULES_FOR_SUBJECT(subject.latinName, periodLabel(period));
    }
    const scores = await scoresUnder(tx, config.id);
    if (scores) throw Errors.RULES_HAVE_SCORES(config.subject.latinName, periodLabel(period), scores);
    await tx.subjectAssessmentConfig.delete({ where: { id: config.id } }); // components cascade
    await audit(tx, {
      ...auditPeriod(period),
      entityLabel: `${config.subject.code} — ${periodLabel(period)}`,
      action: 'SUBJECT_RULES_REMOVED',
      before: rulesSnapshot(config),
    });
  });
}

/**
 * Copies every subject's rules from another period (e.g. last month, or the same month last year) into this
 * one. Subjects that already have rules here are left as they are and reported as skipped.
 */
export async function copyRules(periodId: string, fromPeriodId: string) {
  if (periodId === fromPeriodId) throw Errors.COPY_FROM_SAME_PERIOD();
  return prisma.$transaction(async (tx) => {
    const period = await lockOpenPeriod(tx, periodId);
    const source = await tx.assessmentPeriod.findUnique({
      where: { id: fromPeriodId },
      include: { academicYear: true, subjectConfigs: { include: { subject: true, components: true } } },
    });
    if (!source) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();

    const present = new Set((await tx.subjectAssessmentConfig.findMany({ where: { assessmentPeriodId: periodId } })).map((c) => c.subjectId));
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const c of source.subjectConfigs) {
      if (present.has(c.subjectId)) {
        skipped.push(c.subject.code);
        continue;
      }
      await tx.subjectAssessmentConfig.create({
        data: {
          subjectId: c.subjectId,
          assessmentPeriodId: periodId,
          maxTotalScore: c.maxTotalScore,
          isComponentBased: c.isComponentBased,
          components: { create: c.components.map((k) => ({ name: k.name, maxScore: k.maxScore })) },
        },
      });
      copied.push(c.subject.code);
    }
    if (copied.length) {
      await audit(tx, { ...auditPeriod(period), action: 'SUBJECT_RULES_COPIED', after: { from: periodLabel(source), copied, skipped } });
    }
    return { from: { id: source.id, name: periodLabel(source) }, copied: copied.sort(), skipped: skipped.sort() };
  });
}
