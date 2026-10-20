import { DEFAULT_SUBJECTS } from '../constants/curriculum';
import { educationLevelOf, GRADE_RANGE, gradesFor, isSchoolLevel, LEVEL_LABEL } from '../constants/school-levels';
import { Prisma, SchoolLevel } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';

const SETTINGS_ID = 1;

export interface UpdateSchoolSettingsInput {
  level?: SchoolLevel;
  khmerName?: string | null;
  latinName?: string | null;
  moeysCode?: string | null;
  address?: string | null;
  phone?: string | null;
}

const withRange = <T extends { level: SchoolLevel }>(settings: T) => ({
  ...settings,
  levelLabel: LEVEL_LABEL[settings.level],
  gradeRange: GRADE_RANGE[settings.level],
  grades: gradesFor(settings.level),
});

/**
 * The settings row always exists after the first call. On first install the level comes from
 * SCHOOL_LEVEL in .env (default COMBINED); after that the database is the source of truth.
 */
export async function ensureSchoolSettings(db: Prisma.TransactionClient = prisma) {
  const existing = await db.schoolSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (existing) return existing;

  const envLevel = process.env.SCHOOL_LEVEL;
  if (envLevel && !isSchoolLevel(envLevel)) {
    throw new Error(`SCHOOL_LEVEL must be one of ${Object.values(SchoolLevel).join(', ')} (got "${envLevel}")`);
  }
  return db.schoolSettings.upsert({
    where: { id: SETTINGS_ID },
    update: {},
    create: {
      id: SETTINGS_ID,
      level: (envLevel as SchoolLevel | undefined) ?? SchoolLevel.COMBINED,
      khmerName: process.env.SCHOOL_KHMER_NAME || null,
      latinName: process.env.SCHOOL_LATIN_NAME || null,
    },
  });
}

export async function getSchoolLevel() {
  return (await ensureSchoolSettings()).level;
}

export async function getSchoolSettings() {
  return withRange(await ensureSchoolSettings());
}

/** Throws 400 GRADE_NOT_OFFERED when the grade is outside this school's level. */
export async function assertGradeOffered(gradeNumber: number) {
  const level = await getSchoolLevel();
  const { min, max } = GRADE_RANGE[level];
  if (gradeNumber < min || gradeNumber > max) {
    throw new HttpError(400, 'GRADE_NOT_OFFERED', `Grade ${gradeNumber} is not offered: this school is ${LEVEL_LABEL[level]}`, {
      allowedGrades: gradesFor(level),
    });
  }
}

/**
 * Creates any missing grades for the level and links the default MoEYS subjects (those that exist)
 * to each newly created grade. Existing grades are left untouched.
 */
export async function addMissingGrades(db: Prisma.TransactionClient, level: SchoolLevel) {
  const existing = new Set((await db.grade.findMany({ select: { gradeNumber: true } })).map((g) => g.gradeNumber));
  const subjects = new Map((await db.subject.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));
  const added: number[] = [];

  for (const gradeNumber of gradesFor(level).filter((n) => !existing.has(n))) {
    const subjectIds = DEFAULT_SUBJECTS.filter((s) => s.grades.includes(gradeNumber) && subjects.has(s.code)).map((s) => subjects.get(s.code)!);
    await db.grade.create({
      data: {
        gradeNumber,
        level: educationLevelOf(gradeNumber),
        gradeSubjects: { create: subjectIds.map((subjectId) => ({ subjectId })) },
      },
    });
    added.push(gradeNumber);
  }
  return added;
}

/**
 * Updates the school profile. Changing the level adds the new range's grades and removes grades
 * outside it — refused while any of those grades still has class sections (current or historical).
 */
export async function updateSchoolSettings(data: UpdateSchoolSettingsInput) {
  return prisma.$transaction(async (tx) => {
    const current = await ensureSchoolSettings(tx);
    let gradesAdded: number[] = [];
    let gradesRemoved: number[] = [];

    if (data.level && data.level !== current.level) {
      const { min, max } = GRADE_RANGE[data.level];
      const outside = await tx.grade.findMany({
        where: { OR: [{ gradeNumber: { lt: min } }, { gradeNumber: { gt: max } }] },
        include: { _count: { select: { classes: true } } },
        orderBy: { gradeNumber: 'asc' },
      });
      const inUse = outside.filter((g) => g._count.classes > 0);
      if (inUse.length) {
        throw new HttpError(
          409,
          'LEVEL_CHANGE_BLOCKED',
          `Cannot switch to ${LEVEL_LABEL[data.level]}: grade(s) ${inUse.map((g) => g.gradeNumber).join(', ')} still have class sections`,
          { gradesInUse: inUse.map((g) => ({ gradeNumber: g.gradeNumber, classSections: g._count.classes })) },
        );
      }
      // Grade-subject links cascade with the grade
      await tx.grade.deleteMany({ where: { id: { in: outside.map((g) => g.id) } } });
      gradesRemoved = outside.map((g) => g.gradeNumber);
      gradesAdded = await addMissingGrades(tx, data.level);
    }

    const updated = await tx.schoolSettings.update({ where: { id: SETTINGS_ID }, data });
    return { settings: withRange(updated), gradesAdded, gradesRemoved };
  });
}
