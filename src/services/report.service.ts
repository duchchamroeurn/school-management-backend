// Data for the printed MoEYS reports: class lists, gender statistics and report cards. Each function returns
// plain data; src/reports/ turns it into printable HTML or Excel, and the API can also return it as JSON.
import { Errors } from '../constants/errors';
import { mentionInfo } from '../constants/grading';
import { AcademicYearStatus, EnrollmentType, Gender, StudentStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getSchoolSettings } from './school-settings.service';

export interface ReportCardViewer {
  staffProfileId: string | null;
  canViewAny: boolean; // VIEW_ANY_REPORT_CARDS; otherwise only the user's homeroom class
}

const className = (c: { sectionName: string; grade: { gradeNumber: number } }) => `${c.grade.gradeNumber}${c.sectionName}`;

async function schoolHeader() {
  const s = await getSchoolSettings();
  return { khmerName: s.khmerName, latinName: s.latinName, moeysCode: s.moeysCode, address: s.address, levelLabel: s.levelLabel };
}

// ── Class list (បញ្ជីឈ្មោះសិស្ស) ───────────────────────────────────────────

export async function getClassList(classSectionId: string) {
  const classSection = await prisma.classSection.findUnique({
    where: { id: classSectionId },
    include: {
      grade: true,
      academicYear: { select: { id: true, name: true, status: true } },
      homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
      enrollments: { include: { student: true }, orderBy: { student: { khmerName: 'asc' } } },
    },
  });
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();

  const students = classSection.enrollments.map((e, i) => ({
    no: i + 1,
    studentId: e.student.id,
    studentIdentifier: e.student.studentIdentifier,
    khmerName: e.student.khmerName,
    latinName: e.student.latinName,
    gender: e.student.gender,
    dateOfBirth: e.student.dateOfBirth,
    enrollmentType: e.enrollmentType,
    status: e.student.status,
  }));
  const active = students.filter((s) => s.status === StudentStatus.ENROLLED);
  return {
    school: await schoolHeader(),
    classSection: {
      id: classSection.id,
      name: className(classSection),
      gradeNumber: classSection.grade.gradeNumber,
      academicYear: classSection.academicYear,
      homeroomTeacher: classSection.homeroomTeacher,
    },
    summary: {
      total: students.length,
      female: students.filter((s) => s.gender === Gender.F).length,
      active: active.length,
      activeFemale: active.filter((s) => s.gender === Gender.F).length,
    },
    students,
  };
}

// ── Gender statistics (ស្ថិតិសិស្ស តាមភេទ) ────────────────────────────────────

type Count = { total: number; female: number };
const COLUMNS = ['enrolled', 'newAdmissions', 'promoted', 'repeating', 'droppedOut', 'graduated', 'active'] as const;
type Row = Record<(typeof COLUMNS)[number], Count>;

const emptyRow = (): Row => Object.fromEntries(COLUMNS.map((c) => [c, { total: 0, female: 0 }])) as Row;
const addTo = (row: Row, column: keyof Row, gender: Gender) => {
  row[column].total++;
  if (gender === Gender.F) row[column].female++;
};
const sumRows = (rows: Row[]) => {
  const total = emptyRow();
  for (const r of rows) for (const c of COLUMNS) (total[c].total += r[c].total), (total[c].female += r[c].female);
  return total;
};

/**
 * Per class, per grade and for the whole school, in the given or the ACTIVE academic year:
 * enrolled (everyone enrolled this year) = newAdmissions + promoted + repeating; of those, droppedOut and
 * graduated left, and active are still studying. Every figure is a total and the number of girls.
 */
export async function getGenderStatistics(academicYearId?: string) {
  const academicYear = academicYearId
    ? await prisma.academicYear.findUnique({ where: { id: academicYearId } })
    : await prisma.academicYear.findFirst({ where: { status: AcademicYearStatus.ACTIVE } });
  if (!academicYear) throw academicYearId ? Errors.ACADEMIC_YEAR_NOT_FOUND() : Errors.ACADEMIC_YEAR_REQUIRED();

  const classes = await prisma.classSection.findMany({
    where: { academicYearId: academicYear.id },
    include: { grade: true, enrollments: { select: { enrollmentType: true, student: { select: { gender: true, status: true } } } } },
    orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
  });

  const TYPE_COLUMN: Record<EnrollmentType, keyof Row> = { NEW_ADMISSION: 'newAdmissions', PROMOTED: 'promoted', REPEATING: 'repeating' };
  const STATUS_COLUMN: Record<StudentStatus, keyof Row> = { ENROLLED: 'active', DROPPED_OUT: 'droppedOut', GRADUATED: 'graduated' };

  const classRows = classes.map((c) => {
    const row = emptyRow();
    for (const e of c.enrollments) {
      addTo(row, 'enrolled', e.student.gender);
      addTo(row, TYPE_COLUMN[e.enrollmentType], e.student.gender);
      addTo(row, STATUS_COLUMN[e.student.status], e.student.gender);
    }
    return { classSectionId: c.id, name: className(c), gradeNumber: c.grade.gradeNumber, ...row };
  });

  const gradeNumbers = [...new Set(classRows.map((r) => r.gradeNumber))];
  const grades = gradeNumbers.map((gradeNumber) => {
    const rows = classRows.filter((r) => r.gradeNumber === gradeNumber);
    return { gradeNumber, classes: rows, total: sumRows(rows) };
  });

  return {
    school: await schoolHeader(),
    academicYear: { id: academicYear.id, name: academicYear.name, status: academicYear.status },
    columns: COLUMNS,
    grades,
    total: sumRows(classRows),
  };
}

// ── Report cards (សៀវភៅតាមដាន / ព្រឹត្តិបត្រពិន្ទុ) ─────────────────────────

/** One card per student (or only studentId), from the calculated results of the period. */
export async function getReportCards(viewer: ReportCardViewer, classSectionId: string, assessmentPeriodId: string, studentId?: string) {
  const [classSection, period] = await Promise.all([
    prisma.classSection.findUnique({
      where: { id: classSectionId },
      include: {
        grade: { include: { gradeSubjects: true } },
        academicYear: { select: { id: true, name: true } },
        homeroomTeacher: { select: { id: true, khmerName: true, latinName: true } },
      },
    }),
    prisma.assessmentPeriod.findUnique({ where: { id: assessmentPeriodId }, include: { academicYear: true } }),
  ]);
  if (!classSection) throw Errors.CLASS_SECTION_NOT_FOUND();
  if (!period) throw Errors.ASSESSMENT_PERIOD_NOT_FOUND();
  const name = className(classSection);
  const periodName = `${period.name} ${period.academicYear.name}`;
  if (!viewer.canViewAny && (!viewer.staffProfileId || classSection.homeroomTeacherId !== viewer.staffProfileId)) {
    throw Errors.NOT_HOMEROOM_FOR_CLASS(name, 'print its report cards');
  }
  if (classSection.academicYearId !== period.academicYearId) throw Errors.PERIOD_NOT_IN_CLASS_YEAR(periodName, name, classSection.academicYear.name);

  const results = await prisma.monthlyResult.findMany({
    where: { assessmentPeriodId: period.id, enrollment: { classSectionId: classSection.id } },
    include: { enrollment: { include: { student: true } } },
    orderBy: [{ classRank: 'asc' }, { enrollment: { student: { khmerName: 'asc' } } }],
  });
  if (results.length === 0) throw Errors.RESULTS_NOT_CALCULATED(name, periodName);
  const selected = studentId ? results.filter((r) => r.enrollment.studentId === studentId) : results;
  if (selected.length === 0) throw Errors.STUDENT_NOT_IN_REPORT();

  const configs = await prisma.subjectAssessmentConfig.findMany({
    where: { assessmentPeriodId: period.id, subjectId: { in: classSection.grade.gradeSubjects.map((gs) => gs.subjectId) } },
    include: { subject: true, components: { orderBy: { name: 'asc' } } },
    orderBy: [{ subject: { isCoreSubject: 'desc' } }, { subject: { code: 'asc' } }],
  });
  const enrollmentIds = selected.map((r) => r.enrollmentId);
  const [subjectScores, componentScores] = await Promise.all([
    prisma.monthlySubjectScore.findMany({ where: { enrollmentId: { in: enrollmentIds }, subjectAssessmentConfigId: { in: configs.map((c) => c.id) } } }),
    prisma.componentScore.findMany({
      where: { enrollmentId: { in: enrollmentIds }, subjectComponentId: { in: configs.flatMap((c) => c.components.map((k) => k.id)) } },
    }),
  ]);
  const subjectScore = new Map(subjectScores.map((s) => [`${s.enrollmentId}:${s.subjectAssessmentConfigId}`, s.score]));
  const componentScore = new Map(componentScores.map((s) => [`${s.enrollmentId}:${s.subjectComponentId}`, s.score]));
  const maxTotal = configs.reduce((sum, c) => sum + Math.round(c.maxTotalScore * 100), 0) / 100;

  return {
    school: await schoolHeader(),
    classSection: { id: classSection.id, name, gradeNumber: classSection.grade.gradeNumber, homeroomTeacher: classSection.homeroomTeacher },
    assessmentPeriod: { id: period.id, name: period.name, academicYear: period.academicYear.name },
    classSize: results.length,
    maxTotal,
    cards: selected.map((r) => {
      const s = r.enrollment.student;
      const mention = mentionInfo(r.mention);
      return {
        student: { id: s.id, studentIdentifier: s.studentIdentifier, khmerName: s.khmerName, latinName: s.latinName, gender: s.gender, dateOfBirth: s.dateOfBirth },
        subjects: configs.map((c) => ({
          code: c.subject.code,
          khmerName: c.subject.khmerName,
          latinName: c.subject.latinName,
          maxScore: c.maxTotalScore,
          score: subjectScore.get(`${r.enrollmentId}:${c.id}`) ?? null,
          components: c.isComponentBased
            ? c.components.map((k) => ({ name: k.name, maxScore: k.maxScore, score: componentScore.get(`${r.enrollmentId}:${k.id}`) ?? null }))
            : [],
        })),
        totalScore: r.totalScore,
        average: r.average,
        mention: r.mention,
        mentionKhmer: mention.khmer,
        mentionLatin: mention.latin,
        classRank: r.classRank,
        remarks: r.remarks,
      };
    }),
  };
}

export type ClassListReport = Awaited<ReturnType<typeof getClassList>>;
export type GenderStatisticsReport = Awaited<ReturnType<typeof getGenderStatistics>>;
export type ReportCardsReport = Awaited<ReturnType<typeof getReportCards>>;
