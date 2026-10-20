// How a student's period result is calculated (MonthlyResult):
//
//   average = total score ÷ total possible score × 100      (a percentage, two decimals)
//   mention = MoEYS letter scale on that percentage (below)
//   rank    = position in the class by average; equal averages share a rank (1, 1, 3, …)
//
// Change the thresholds here if the school's rules differ; recalculating a period applies them.
import { Mention } from '../generated/prisma/client';

export const MENTION_SCALE: { mention: Mention; minAverage: number; khmer: string; latin: string }[] = [
  { mention: Mention.A, minAverage: 90, khmer: 'ល្អប្រសើរ', latin: 'Excellent' },
  { mention: Mention.B, minAverage: 80, khmer: 'ល្អណាស់', latin: 'Very good' },
  { mention: Mention.C, minAverage: 70, khmer: 'ល្អ', latin: 'Good' },
  { mention: Mention.D, minAverage: 60, khmer: 'ល្អបង្គួរ', latin: 'Fairly good' },
  { mention: Mention.E, minAverage: 50, khmer: 'មធ្យម', latin: 'Average' },
  { mention: Mention.F, minAverage: 0, khmer: 'ខ្សោយ', latin: 'Weak' },
];

export const mentionFor = (average: number): Mention => MENTION_SCALE.find((m) => average >= m.minAverage)!.mention;

export const mentionInfo = (mention: Mention) => MENTION_SCALE.find((m) => m.mention === mention)!;
