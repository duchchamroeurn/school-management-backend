// Period results (MonthlyResult): each active student's total, average, mention and rank in their class for one
// assessment period, calculated from the subject scores. See src/constants/grading.ts for the formula.
//
// Calculation refuses to run while any active student is missing a score, so a rank is never based on gaps.
// Recalculating replaces the numbers (e.g. after a score correction) but keeps the teacher's remarks.
import { Errors } from '../constants/errors';
import { mentionFor } from '../constants/grading';
import { AcademicYearStatus, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';

export interface ResultsActor {
  staffProfileId: string | null;
  canCalculateAny: boolean; // CALCULATE_ANY_RESULTS; otherwise only the user's homeroom class
}

const hundredths = (value: number) => Math.round(value * 100);
const round2 = (value: number) => Math.round(value * 100) / 100;

export async function calculateResults(actor: ResultsActor, classSectionId: string, assessmentPeriodId: string) {
  return prisma.$transaction(
    async (tx) => {
      // The period stays open (not locked) for the whole calculation
      const [lockedPeriod] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM assessment_periods WHERE id = ${assessmentPeriodId} FOR SHARE`;
      if (!lockedPeriod) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
      const period = await tx.assessmentPeriod.findUniqueOrThrow({ where: { id: assessmentPeriodId }, include: { academicYear: true } });
      const periodName = `${period.name} ${period.academicYear.name}`;

      const classSection = await tx.classSection.findUnique({
        where: { id: classSectionId },
        include: { grade: { include: { gradeSubjects: true } }, academicYear: true },
      });
      if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
      const className = `${classSection.grade.gradeNumber}${classSection.sectionName}`;
      if (!actor.canCalculateAny && (!actor.staffProfileId || classSection.homeroomTeacherId !== actor.staffProfileId)) {
        throw Errors.NOT_HOMEROOM_FOR_CLASS(className, 'calculate its results');
      }
      if (classSection.academicYearId !== period.academicYearId) {
        throw Errors.PERIOD_NOT_IN_CLASS_YEAR(periodName, className, classSection.academicYear.name);
      }
      if (period.isLocked) throw Errors.PERIOD_LOCKED(period.name, period.academicYear.name);
      if (period.academicYear.status === AcademicYearStatus.COMPLETED) throw Errors.ACADEMIC_YEAR_CLOSED(period.academicYear.name, 'its scores');

      // ── The subjects that count: taught in this grade and scored in this period ──
      const gradeSubjectIds = classSection.grade.gradeSubjects.map((gs) => gs.subjectId);
      const configs = await tx.subjectAssessmentConfig.findMany({
        where: { assessmentPeriodId: period.id, subjectId: { in: gradeSubjectIds } },
        include: { subject: { select: { code: true } } },
        orderBy: { subject: { code: 'asc' } },
      });
      if (configs.length === 0) throw Errors.NO_SUBJECTS_CONFIGURED(periodName, classSection.grade.gradeNumber);
      const maxTotal = configs.reduce((sum, c) => sum + hundredths(c.maxTotalScore), 0) / 100;

      // ── Active students and their scores ───────────────────────────────
      const enrollments = await tx.yearlyEnrollment.findMany({
        where: { classSectionId: classSection.id, student: { status: StudentStatus.ENROLLED } },
        include: { student: { select: { studentIdentifier: true, khmerName: true, latinName: true } } },
      });
      const scores = await tx.monthlySubjectScore.findMany({
        where: { enrollmentId: { in: enrollments.map((e) => e.id) }, subjectAssessmentConfigId: { in: configs.map((c) => c.id) } },
      });
      const scoreOf = new Map(scores.map((s) => [`${s.enrollmentId}:${s.subjectAssessmentConfigId}`, s.score]));

      const missing = enrollments
        .map((e) => ({
          studentIdentifier: e.student.studentIdentifier,
          latinName: e.student.latinName,
          subjects: configs.filter((c) => !scoreOf.has(`${e.id}:${c.id}`)).map((c) => c.subject.code),
        }))
        .filter((m) => m.subjects.length > 0);
      if (missing.length) throw Errors.SCORES_INCOMPLETE(className, periodName, missing);

      // ── Totals, averages, mentions, ranks ──────────────────────────────
      const results = enrollments.map((e) => {
        const totalScore = configs.reduce((sum, c) => sum + hundredths(scoreOf.get(`${e.id}:${c.id}`)!), 0) / 100;
        const average = round2((totalScore / maxTotal) * 100);
        return { enrollment: e, totalScore, average, mention: mentionFor(average), classRank: 0 };
      });
      results.sort((a, b) => b.average - a.average);
      // Competition ranking: equal averages share a rank and the next rank skips (1, 1, 3)
      results.forEach((r, i) => {
        r.classRank = i > 0 && r.average === results[i - 1].average ? results[i - 1].classRank : i + 1;
      });

      for (const r of results) {
        const values = { totalScore: r.totalScore, average: r.average, mention: r.mention, classRank: r.classRank };
        await tx.monthlyResult.upsert({
          where: { enrollmentId_assessmentPeriodId: { enrollmentId: r.enrollment.id, assessmentPeriodId: period.id } },
          create: { enrollmentId: r.enrollment.id, assessmentPeriodId: period.id, ...values },
          update: values, // remarks are kept
        });
      }
      // A student who left the class (dropped out, transferred) since the last calculation no longer has a result here
      await tx.monthlyResult.deleteMany({
        where: { assessmentPeriodId: period.id, enrollment: { classSectionId: classSection.id }, enrollmentId: { notIn: results.map((r) => r.enrollment.id) } },
      });

      const summary = {
        students: results.length,
        subjects: configs.length,
        maxTotal,
        classAverage: results.length ? round2(results.reduce((s, r) => s + r.average, 0) / results.length) : null,
        passed: results.filter((r) => r.mention !== 'F').length,
      };
      await audit(tx, {
        entityType: 'ClassSection',
        action: 'RESULTS_CALCULATED',
        entityId: classSection.id,
        entityLabel: `${className} — ${periodName}`,
        after: summary,
      });

      return {
        classSection: { id: classSection.id, name: className },
        assessmentPeriod: { id: period.id, name: period.name, academicYear: period.academicYear.name },
        summary,
        results: results.map((r) => ({
          enrollmentId: r.enrollment.id,
          studentId: r.enrollment.studentId,
          studentIdentifier: r.enrollment.student.studentIdentifier,
          khmerName: r.enrollment.student.khmerName,
          latinName: r.enrollment.student.latinName,
          totalScore: r.totalScore,
          average: r.average,
          mention: r.mention,
          classRank: r.classRank,
        })),
      };
    },
    { timeout: 60_000 },
  );
}

/** The homeroom teacher's comment on a student's report card (មតិយោបល់). null clears it. */
export async function updateRemarks(actor: ResultsActor, assessmentPeriodId: string, studentId: string, remarks: string | null) {
  return prisma.$transaction(async (tx) => {
    const period = await tx.assessmentPeriod.findUnique({ where: { id: assessmentPeriodId }, include: { academicYear: true } });
    if (!period) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
    const result = await tx.monthlyResult.findFirst({
      where: { assessmentPeriodId, enrollment: { studentId, academicYearId: period.academicYearId } },
      include: { enrollment: { include: { student: true, classSection: { include: { grade: true } } } } },
    });
    if (!result) throw Errors.STUDENT_NOT_IN_REPORT();
    const { classSection, student } = result.enrollment;
    const className = `${classSection.grade.gradeNumber}${classSection.sectionName}`;
    if (!actor.canCalculateAny && (!actor.staffProfileId || classSection.homeroomTeacherId !== actor.staffProfileId)) {
      throw Errors.NOT_HOMEROOM_FOR_CLASS(className, 'write its report card remarks');
    }
    if (period.isLocked) throw Errors.PERIOD_LOCKED(period.name, period.academicYear.name);

    const updated = await tx.monthlyResult.update({ where: { id: result.id }, data: { remarks } });
    await audit(tx, {
      entityType: 'Result',
      action: 'RESULT_REMARKS_UPDATED',
      entityId: result.id,
      entityLabel: `${student.studentIdentifier} ${student.latinName} — ${period.name} ${period.academicYear.name}`,
      before: { remarks: result.remarks },
      after: { remarks },
    });
    return { studentId, assessmentPeriodId, classSection: className, remarks: updated.remarks };
  });
}
