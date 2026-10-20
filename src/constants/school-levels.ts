import { EducationLevel, SchoolLevel } from '../generated/prisma/client';

// Grades each school level offers (inclusive)
export const GRADE_RANGE: Record<SchoolLevel, { min: number; max: number }> = {
  LOWER_SECONDARY: { min: 7, max: 9 },
  UPPER_SECONDARY: { min: 10, max: 12 },
  COMBINED: { min: 7, max: 12 },
};

// Plausible student age (years) at registration, per school level
export const STUDENT_AGE_RANGE: Record<SchoolLevel, { min: number; max: number }> = {
  LOWER_SECONDARY: { min: 10, max: 20 },
  UPPER_SECONDARY: { min: 13, max: 25 },
  COMBINED: { min: 10, max: 25 },
};

export const LEVEL_LABEL: Record<SchoolLevel, string> = {
  LOWER_SECONDARY: 'អនុវិទ្យាល័យ / Lower secondary (grades 7–9)',
  UPPER_SECONDARY: 'វិទ្យាល័យ / Upper secondary (grades 10–12)',
  COMBINED: 'វិទ្យាល័យ / Combined secondary (grades 7–12)',
};

export const gradesFor = (level: SchoolLevel) => {
  const { min, max } = GRADE_RANGE[level];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
};

export const educationLevelOf = (gradeNumber: number) =>
  gradeNumber <= 9 ? EducationLevel.LOWER_SECONDARY : EducationLevel.UPPER_SECONDARY;

export const isSchoolLevel = (value: string | undefined): value is SchoolLevel =>
  value !== undefined && (Object.values(SchoolLevel) as string[]).includes(value);
