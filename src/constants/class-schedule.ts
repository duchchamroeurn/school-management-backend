// When a class studies (ClassSchedule) and what that means for the bell schedule's shifts.
import { ClassSchedule, Shift } from '../generated/prisma/client';

export const CLASS_SCHEDULES = Object.values(ClassSchedule);

const HALF_DAY: Record<ClassSchedule, Shift | null> = {
  [ClassSchedule.FULL_DAY]: null,
  [ClassSchedule.MORNING]: Shift.MORNING,
  [ClassSchedule.AFTERNOON]: Shift.AFTERNOON,
};

/** The only shift a half-day class studies in; null for a full-day class, which uses every slot. */
export const halfDayShift = (schedule: ClassSchedule): Shift | null => HALF_DAY[schedule];
