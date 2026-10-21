// Score entry for subject teachers. How a subject is scored depends on the month: the rules come from the
// SubjectAssessmentConfig for (subject, assessment period), never from the subject itself. So Math can be
// entered as one total in January and as Homework + Oral + Exam in February.
import { Errors } from '../constants/errors';
import { AcademicYearStatus, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { assertConfigComponentsValid } from '../utils/assessment';
import { isoDate, todayAtSchool } from '../utils/dates';
import { audit } from './audit.service';

export interface ComponentScoreInput {
  componentId: string;
  score: number;
}

export interface RecordSubjectScoreInput {
  studentId: string;
  subjectId: string;
  assessmentPeriodId: string;
  classSectionId?: string; // optional; must be the class the student is enrolled in that year
  totalScoreAchieved?: number; // months where the subject is scored directly
  components?: ComponentScoreInput[]; // months where the subject is component-based
}

// Scores have at most two decimals; add them as whole hundredths so 7.1 + 2.2 is exactly 9.3
const hundredths = (value: number) => Math.round(value * 100);
const sumScores = (scores: number[]) => scores.reduce((sum, s) => sum + hundredths(s), 0) / 100;

export interface ScoreActor {
  staffProfileId: string | null; // the signed-in user's staff profile (null for non-staff logins)
  // ENTER_ANY_SCORES: may score any subject and class; otherwise only where they hold the SubjectTeacherAssignment
  canEnterAnyScore: boolean;
}

/**
 * Records (or corrects) one student's score for one subject in one assessment period.
 * Everything is read and written in one transaction, and the period row is share-locked, so the period
 * can't be locked halfway through and component scores always match the stored total.
 */
export async function recordSubjectScore(actor: ScoreActor, input: RecordSubjectScoreInput) {
  return prisma.$transaction(async (tx) => {
    // ── The period: must exist and still be open ─────────────────────────
    const [lockedPeriod] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM assessment_periods WHERE id = ${input.assessmentPeriodId} FOR SHARE`;
    if (!lockedPeriod) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
    const period = await tx.assessmentPeriod.findUniqueOrThrow({ where: { id: input.assessmentPeriodId }, include: { academicYear: true } });
    const periodName = `${period.name} ${period.academicYear.name}`;
    if (period.isLocked) throw Errors.PERIOD_LOCKED(period.name, period.academicYear.name);
    // After the deadline only ENTER_ANY_SCORES (principal) can still correct scores
    if (!actor.canEnterAnyScore && period.scoreEntryDeadline && todayAtSchool() > isoDate(period.scoreEntryDeadline)) {
      throw Errors.SCORE_DEADLINE_PASSED(periodName, isoDate(period.scoreEntryDeadline));
    }
    if (period.academicYear.status === AcademicYearStatus.COMPLETED) throw Errors.ACADEMIC_YEAR_CLOSED(period.academicYear.name, 'its scores');

    // ── The subject, and the student's enrollment that year in a grade that teaches it ──
    const subject = await tx.subject.findUnique({ where: { id: input.subjectId } });
    if (!subject) throw Errors.SUBJECT_NOT_FOUND();
    const subjectName = subject.latinName;
    const student = await tx.studentProfile.findUnique({ where: { id: input.studentId } });
    if (!student) throw Errors.STUDENT_NOT_FOUND();
    const enrollment = await tx.yearlyEnrollment.findUnique({
      where: { studentId_academicYearId: { studentId: student.id, academicYearId: period.academicYearId } },
      include: { classSection: { include: { grade: { include: { gradeSubjects: { where: { subjectId: subject.id } } } } } } },
    });
    if (!enrollment) throw Errors.STUDENT_NOT_ENROLLED_IN_YEAR(student.studentIdentifier, period.academicYear.name);
    const { grade } = enrollment.classSection;
    const className = `${grade.gradeNumber}${enrollment.classSection.sectionName}`;
    // The class always comes from the enrollment; a classSectionId sent by the client must agree with it
    if (input.classSectionId !== undefined && input.classSectionId !== enrollment.classSectionId) {
      throw Errors.STUDENT_NOT_IN_CLASS(student.studentIdentifier, className);
    }
    if (grade.gradeSubjects.length === 0) throw Errors.SUBJECT_NOT_IN_GRADE(subjectName, grade.gradeNumber);

    // ── Data scope: checked before anything about the subject's rules is read or revealed.
    //    Only the teacher assigned to this subject in this class and year, unless ENTER_ANY_SCORES ──
    if (!actor.canEnterAnyScore) {
      const assignment =
        actor.staffProfileId &&
        (await tx.subjectTeacherAssignment.findUnique({
          where: {
            subjectId_classSectionId_academicYearId: {
              subjectId: subject.id,
              classSectionId: enrollment.classSectionId,
              academicYearId: enrollment.academicYearId,
            },
          },
          select: { staffProfileId: true },
        }));
      if (!assignment || assignment.staffProfileId !== actor.staffProfileId) {
        throw Errors.NOT_TEACHING_SUBJECT(subjectName, className);
      }
    }

    // ── This month's rules for the subject ───────────────────────────────
    const config = await tx.subjectAssessmentConfig.findUnique({
      where: { subjectId_assessmentPeriodId: { subjectId: subject.id, assessmentPeriodId: period.id } },
      include: { subject: true, components: { orderBy: { name: 'asc' } } },
    });
    if (!config) throw Errors.NO_ASSESSMENT_CONFIG(subjectName, periodName);
    // Never score against broken rules (e.g. components that don't add up to the maximum)
    assertConfigComponentsValid(config);

    // Current scores, for the audit log's before/after
    const previous = await tx.monthlySubjectScore.findUnique({
      where: { enrollmentId_subjectAssessmentConfigId: { enrollmentId: enrollment.id, subjectAssessmentConfigId: config.id } },
    });
    const previousComponents = await tx.componentScore.findMany({
      where: { enrollmentId: enrollment.id, subjectComponentId: { in: config.components.map((c) => c.id) } },
    });

    let totalScore: number;
    let componentResults: { componentId: string; name: string; maxScore: number; score: number }[] = [];

    if (!config.isComponentBased) {
      // ── Direct entry this month ────────────────────────────────────────
      if (input.components !== undefined) throw Errors.COMPONENTS_NOT_EXPECTED(subjectName, periodName);
      if (input.totalScoreAchieved === undefined) throw Errors.TOTAL_SCORE_REQUIRED(subjectName, periodName);
      if (input.totalScoreAchieved > config.maxTotalScore) {
        throw Errors.SCORE_OUT_OF_RANGE('totalScoreAchieved', config.maxTotalScore);
      }
      totalScore = input.totalScoreAchieved;
    } else {
      // ── Component-based this month ─────────────────────────────────────
      if (input.totalScoreAchieved !== undefined) throw Errors.TOTAL_NOT_EXPECTED(subjectName, periodName);
      if (!input.components?.length) throw Errors.COMPONENT_SCORES_REQUIRED(subjectName, periodName);

      // Exactly this config's components, each once
      const byId = new Map(config.components.map((c) => [c.id, c]));
      const sent = input.components.map((c) => c.componentId);
      const unknown = [...new Set(sent.filter((id) => !byId.has(id)))];
      const duplicated = [...new Set(sent.filter((id, i) => sent.indexOf(id) !== i))];
      const missing = config.components.filter((c) => !sent.includes(c.id)).map((c) => ({ componentId: c.id, name: c.name }));
      if (unknown.length || duplicated.length || missing.length) throw Errors.COMPONENTS_MISMATCH(unknown, duplicated, missing);

      componentResults = input.components.map(({ componentId, score }) => {
        const component = byId.get(componentId)!;
        if (score > component.maxScore) throw Errors.SCORE_OUT_OF_RANGE(component.name, component.maxScore, componentId);
        return { componentId, name: component.name, maxScore: component.maxScore, score };
      });
      totalScore = sumScores(componentResults.map((c) => c.score));

      for (const c of componentResults) {
        await tx.componentScore.upsert({
          where: { enrollmentId_subjectComponentId: { enrollmentId: enrollment.id, subjectComponentId: c.componentId } },
          create: { enrollmentId: enrollment.id, subjectComponentId: c.componentId, score: c.score },
          update: { score: c.score },
        });
      }
      componentResults.sort((a, b) => a.name.localeCompare(b.name));
    }

    const saved = await tx.monthlySubjectScore.upsert({
      where: { enrollmentId_subjectAssessmentConfigId: { enrollmentId: enrollment.id, subjectAssessmentConfigId: config.id } },
      create: { enrollmentId: enrollment.id, subjectAssessmentConfigId: config.id, score: totalScore },
      update: { score: totalScore },
    });

    const componentName = new Map(config.components.map((c) => [c.id, c.name]));
    await audit(tx, {
      entityType: 'SubjectScore',
      action: 'SUBJECT_SCORE_RECORDED',
      entityId: saved.id,
      entityLabel: `${student.studentIdentifier} ${student.latinName} — ${config.subject.code} — ${periodName}`,
      before: previous && {
        totalScore: previous.score,
        ...(config.isComponentBased && {
          components: Object.fromEntries(previousComponents.map((c) => [componentName.get(c.subjectComponentId)!, c.score])),
        }),
      },
      after: {
        totalScore,
        ...(config.isComponentBased && { components: Object.fromEntries(componentResults.map((c) => [c.name, c.score])) }),
      },
    });

    return {
      created: !previous,
      result: {
        subjectScoreId: saved.id,
        enrollmentId: enrollment.id,
        student: { id: student.id, studentIdentifier: student.studentIdentifier, khmerName: student.khmerName, latinName: student.latinName },
        classSection: `${grade.gradeNumber}${enrollment.classSection.sectionName}`,
        subject: { id: config.subject.id, code: config.subject.code, khmerName: config.subject.khmerName, latinName: config.subject.latinName },
        assessmentPeriod: { id: period.id, name: period.name, academicYear: period.academicYear.name },
        isComponentBased: config.isComponentBased,
        maxTotalScore: config.maxTotalScore,
        totalScore,
        components: componentResults,
      },
    };
  });
}

/** Why a score sheet can't be edited right now (null = it can). */
export type SheetLockReason = 'PERIOD_LOCKED' | 'YEAR_COMPLETED' | 'DEADLINE_PASSED' | 'NO_RULES';

/**
 * The score sheet of one subject in one class for one period: the period's rules for the subject and every
 * active student with the total and component scores already entered (null = not entered yet).
 * Same data scope as recordSubjectScore: the subject's assigned teacher in that class, or ENTER_ANY_SCORES.
 */
export async function getSubjectScoreSheet(actor: ScoreActor, classSectionId: string, subjectId: string, assessmentPeriodId: string) {
  const [classSection, subject, period] = await Promise.all([
    prisma.classSection.findUnique({
      where: { id: classSectionId },
      include: { grade: { include: { gradeSubjects: { where: { subjectId } } } }, academicYear: true },
    }),
    prisma.subject.findUnique({ where: { id: subjectId } }),
    prisma.assessmentPeriod.findUnique({ where: { id: assessmentPeriodId }, include: { academicYear: true } }),
  ]);
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
  if (!subject) throw Errors.SUBJECT_NOT_FOUND();
  if (!period) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
  const className = `${classSection.grade.gradeNumber}${classSection.sectionName}`;
  const periodName = `${period.name} ${period.academicYear.name}`;
  if (classSection.academicYearId !== period.academicYearId) {
    throw Errors.PERIOD_NOT_IN_CLASS_YEAR(periodName, className, classSection.academicYear.name);
  }
  if (classSection.grade.gradeSubjects.length === 0) throw Errors.SUBJECT_NOT_IN_GRADE(subject.latinName, classSection.grade.gradeNumber);

  // ── Data scope, checked before any score is read ──────────────────────
  if (!actor.canEnterAnyScore) {
    const assignment =
      actor.staffProfileId &&
      (await prisma.subjectTeacherAssignment.findUnique({
        where: { subjectId_classSectionId_academicYearId: { subjectId: subject.id, classSectionId: classSection.id, academicYearId: classSection.academicYearId } },
        select: { staffProfileId: true },
      }));
    if (!assignment || assignment.staffProfileId !== actor.staffProfileId) {
      throw Errors.NOT_TEACHING_SUBJECT(subject.latinName, className);
    }
  }

  const config = await prisma.subjectAssessmentConfig.findUnique({
    where: { subjectId_assessmentPeriodId: { subjectId: subject.id, assessmentPeriodId: period.id } },
    include: { components: { orderBy: { name: 'asc' } } },
  });

  const enrollments = await prisma.yearlyEnrollment.findMany({
    where: { classSectionId: classSection.id, student: { status: StudentStatus.ENROLLED } },
    include: { student: { select: { id: true, studentIdentifier: true, khmerName: true, latinName: true, gender: true } } },
    orderBy: { student: { khmerName: 'asc' } },
  });
  const enrollmentIds = enrollments.map((e) => e.id);
  const [totals, componentScores] = config
    ? await Promise.all([
        prisma.monthlySubjectScore.findMany({ where: { subjectAssessmentConfigId: config.id, enrollmentId: { in: enrollmentIds } } }),
        prisma.componentScore.findMany({
          where: { enrollmentId: { in: enrollmentIds }, subjectComponentId: { in: config.components.map((c) => c.id) } },
        }),
      ])
    : [[], []];
  const totalOf = new Map(totals.map((s) => [s.enrollmentId, s.score]));

  // The same conditions recordSubjectScore refuses on, in the same order
  const deadlinePassed = !!period.scoreEntryDeadline && todayAtSchool() > isoDate(period.scoreEntryDeadline);
  const lockReason: SheetLockReason | null = period.isLocked
    ? 'PERIOD_LOCKED'
    : !actor.canEnterAnyScore && deadlinePassed
      ? 'DEADLINE_PASSED'
      : period.academicYear.status === AcademicYearStatus.COMPLETED
        ? 'YEAR_COMPLETED'
        : !config
          ? 'NO_RULES'
          : null;

  const students = enrollments.map((e, i) => ({
    no: i + 1,
    ...e.student,
    totalScore: totalOf.get(e.id) ?? null,
    // componentId → score, only in component-based months
    components: config?.isComponentBased
      ? Object.fromEntries(componentScores.filter((c) => c.enrollmentId === e.id).map((c) => [c.subjectComponentId, c.score]))
      : null,
  }));
  const entered = students.filter((s) => s.totalScore !== null).length;

  return {
    classSection: { id: classSection.id, name: className, academicYear: { id: classSection.academicYear.id, name: classSection.academicYear.name } },
    subject: { id: subject.id, code: subject.code, khmerName: subject.khmerName, latinName: subject.latinName },
    assessmentPeriod: {
      id: period.id,
      name: period.name,
      isLocked: period.isLocked,
      scoreEntryDeadline: period.scoreEntryDeadline && isoDate(period.scoreEntryDeadline),
    },
    rules: config && {
      maxTotalScore: config.maxTotalScore,
      isComponentBased: config.isComponentBased,
      components: config.components.map((c) => ({ id: c.id, name: c.name, maxScore: c.maxScore })),
    },
    canEdit: lockReason === null,
    lockReason,
    summary: { students: students.length, entered, missing: students.length - entered },
    students,
  };
}
