// End-of-year promotion: moves a whole class into the next academic year in one go.
//
// Every active student in the source class is PROMOTED to the next grade (promotedClassSectionId), except
// those listed as repeating (REPEATING into the same grade, repeatingClassSectionId) or excluded (left alone,
// e.g. moving school). In the school's top grade there is no next grade: promoted students GRADUATE instead.
//
// All-or-nothing: one transaction, so if any student can't be placed (e.g. a target class is full) nothing
// changes. dryRun runs every check and returns the same result, then rolls back.
import { Errors } from '../constants/errors';
import { GRADE_RANGE } from '../constants/school-levels';
import { AcademicYearStatus, EnrollmentType, Prisma, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { audit } from './audit.service';
import { enrollContinuingIn } from './enrollment.service';
import { getSchoolLevel } from './school-settings.service';

export interface PromoteClassInput {
  sourceClassSectionId: string;
  promotedClassSectionId?: string; // next grade, next year; not allowed in the top grade (they graduate)
  repeatingClassSectionId?: string; // same grade, next year; required when anyone repeats
  repeatingStudentIds: string[];
  excludedStudentIds: string[];
  dryRun: boolean;
}

// Moving a large class means many queries; give the transaction more than Prisma's 5s default
const TRANSACTION_TIMEOUT_MS = 60_000;

// Thrown at the end of a dry run so the transaction rolls back; carries the result out
class DryRunRollback extends Error {
  constructor(readonly result: PromotionResult) {
    super('dry run');
  }
}

type PromotionResult = Awaited<ReturnType<typeof planAndApply>>;

const className = (c: { sectionName: string; grade: { gradeNumber: number } }) => `${c.grade.gradeNumber}${c.sectionName}`;

type StudentRef = { id: string; studentIdentifier: string; khmerName: string; latinName: string; status: StudentStatus };
const studentDto = (s: StudentRef) => ({ studentId: s.id, studentIdentifier: s.studentIdentifier, khmerName: s.khmerName, latinName: s.latinName });

export async function promoteClass(input: PromoteClassInput): Promise<PromotionResult> {
  const topGrade = GRADE_RANGE[await getSchoolLevel()].max;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const result = await planAndApply(tx, input, topGrade);
        if (input.dryRun) throw new DryRunRollback(result);
        return result;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw Errors.ALREADY_ENROLLED();
    throw err;
  }
}

async function planAndApply(tx: Prisma.TransactionClient, input: PromoteClassInput, topGrade: number) {
  // ── Source class and its students ──────────────────────────────────
  const source = await tx.classSection.findUnique({
    where: { id: input.sourceClassSectionId },
    include: {
      grade: true,
      academicYear: true,
      enrollments: { include: { student: true }, orderBy: { student: { khmerName: 'asc' } } },
    },
  });
  if (!source) throw Errors.CLASS_SECTION_NOT_FOUND();
  const sourceName = className(source);
  if (source.academicYear.status === AcademicYearStatus.UPCOMING) {
    throw Errors.PROMOTION_YEAR_NOT_STARTED(sourceName, source.academicYear.name);
  }

  const inClass = new Set(source.enrollments.map((e) => e.studentId));
  const repeating = new Set(input.repeatingStudentIds);
  const excluded = new Set(input.excludedStudentIds);
  const both = [...repeating].filter((id) => excluded.has(id));
  if (both.length) throw Errors.STUDENT_IN_BOTH_LISTS(both);
  const strangers = [...repeating, ...excluded].filter((id) => !inClass.has(id));
  if (strangers.length) throw Errors.STUDENTS_NOT_IN_CLASS(sourceName, strangers);

  // ── Target classes: right grade, a later academic year, both in the same year ──
  const graduating = source.grade.gradeNumber === topGrade;
  if (graduating && input.promotedClassSectionId) throw Errors.PROMOTED_CLASS_NOT_ALLOWED(source.grade.gradeNumber);

  const loadTarget = async (id: string | undefined, expectedGrade: number, role: 'promoted' | 'repeating') => {
    if (!id) return null;
    const target = await tx.classSection.findUnique({ where: { id }, include: { grade: true, academicYear: true } });
    if (!target) throw Errors.CLASS_SECTION_NOT_FOUND();
    if (target.grade.gradeNumber !== expectedGrade) throw Errors.TARGET_CLASS_WRONG_GRADE(role, className(target), expectedGrade);
    if (target.academicYear.startDate <= source.academicYear.startDate) {
      throw Errors.TARGET_YEAR_NOT_LATER(className(target), target.academicYear.name, source.academicYear.name);
    }
    return target;
  };
  const promotedClass = await loadTarget(input.promotedClassSectionId, source.grade.gradeNumber + 1, 'promoted');
  const repeatingClass = await loadTarget(input.repeatingClassSectionId, source.grade.gradeNumber, 'repeating');
  if (promotedClass && repeatingClass && promotedClass.academicYearId !== repeatingClass.academicYearId) {
    throw Errors.TARGET_CLASSES_DIFFERENT_YEARS(promotedClass.academicYear.name, repeatingClass.academicYear.name);
  }
  const targetYear = (promotedClass ?? repeatingClass)?.academicYear ?? null;

  // Students already placed in the target year (e.g. by hand) are skipped, not moved twice
  const alreadyPlaced = new Set(
    targetYear
      ? (
          await tx.yearlyEnrollment.findMany({
            where: { academicYearId: targetYear.id, studentId: { in: [...inClass] } },
            select: { studentId: true },
          })
        ).map((e) => e.studentId)
      : [],
  );

  // ── Decide for each student ────────────────────────────────────────
  const plan = { promote: [] as StudentRef[], repeat: [] as StudentRef[], graduate: [] as StudentRef[] };
  const skipped = {
    excluded: [] as ReturnType<typeof studentDto>[],
    notActive: [] as (ReturnType<typeof studentDto> & { status: StudentStatus })[],
    alreadyEnrolled: [] as ReturnType<typeof studentDto>[],
  };
  for (const { student } of source.enrollments) {
    if (excluded.has(student.id)) skipped.excluded.push(studentDto(student));
    // Dropped out or graduated: they don't continue (a repeater must still be ENROLLED)
    else if (student.status !== StudentStatus.ENROLLED) skipped.notActive.push({ ...studentDto(student), status: student.status });
    else if (repeating.has(student.id)) {
      if (alreadyPlaced.has(student.id)) skipped.alreadyEnrolled.push(studentDto(student));
      else plan.repeat.push(student);
    } else if (graduating) plan.graduate.push(student);
    else if (alreadyPlaced.has(student.id)) skipped.alreadyEnrolled.push(studentDto(student));
    else plan.promote.push(student);
  }
  if (plan.promote.length && !promotedClass) throw Errors.PROMOTED_CLASS_REQUIRED(plan.promote.length, source.grade.gradeNumber + 1);
  if (plan.repeat.length && !repeatingClass) throw Errors.REPEATING_CLASS_REQUIRED(plan.repeat.length, source.grade.gradeNumber);

  // ── Apply (same checks and capacity lock as a single enrollment) ──────
  for (const s of plan.promote) await enrollContinuingIn(tx, s.id, promotedClass!.id, promotedClass!.academicYearId, EnrollmentType.PROMOTED);
  for (const s of plan.repeat) await enrollContinuingIn(tx, s.id, repeatingClass!.id, repeatingClass!.academicYearId, EnrollmentType.REPEATING);
  for (const s of plan.graduate) {
    await tx.studentProfile.update({ where: { id: s.id }, data: { status: StudentStatus.GRADUATED } });
    await audit(tx, {
      entityType: 'Student',
      action: 'STUDENT_UPDATED',
      entityId: s.id,
      entityLabel: `${s.studentIdentifier} ${s.latinName}`,
      before: { status: s.status },
      after: { status: StudentStatus.GRADUATED },
    });
  }

  const result = {
    dryRun: input.dryRun,
    sourceClass: { id: source.id, name: sourceName, academicYear: source.academicYear.name },
    targetAcademicYear: targetYear && { id: targetYear.id, name: targetYear.name },
    promoted: { classSection: promotedClass && { id: promotedClass.id, name: className(promotedClass) }, students: plan.promote.map(studentDto) },
    repeating: { classSection: repeatingClass && { id: repeatingClass.id, name: className(repeatingClass) }, students: plan.repeat.map(studentDto) },
    graduated: plan.graduate.map(studentDto),
    skipped,
    summary: {
      promoted: plan.promote.length,
      repeating: plan.repeat.length,
      graduated: plan.graduate.length,
      skipped: skipped.excluded.length + skipped.notActive.length + skipped.alreadyEnrolled.length,
    },
  };

  // A run that moved nobody (e.g. repeated after everyone was placed) changed nothing worth auditing
  const moved = plan.promote.length + plan.repeat.length + plan.graduate.length;
  if (moved) {
    await audit(tx, {
      entityType: 'ClassSection',
      action: 'CLASS_PROMOTED',
      entityId: source.id,
      entityLabel: `${sourceName} ${source.academicYear.name}`,
      after: {
        ...result.summary,
        targetAcademicYear: targetYear?.name ?? null,
        promotedTo: result.promoted.classSection?.name ?? null,
        repeatingIn: result.repeating.classSection?.name ?? null,
      },
    });
  }

  return result;
}
