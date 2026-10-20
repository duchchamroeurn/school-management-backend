// Khmer labels and formatting for printed reports (MoEYS documents use Khmer digits and dates).
import { EnrollmentType, Gender, StudentStatus } from '../generated/prisma/client';

export const GENDER_KM: Record<Gender, string> = { M: 'ប្រុស', F: 'ស្រី' };

export const STUDENT_STATUS_KM: Record<StudentStatus, string> = {
  ENROLLED: 'កំពុងសិក្សា',
  GRADUATED: 'បញ្ចប់ការសិក្សា',
  DROPPED_OUT: 'បោះបង់ការសិក្សា',
};

export const ENROLLMENT_TYPE_KM: Record<EnrollmentType, string> = {
  NEW_ADMISSION: 'ចូលរៀនថ្មី',
  PROMOTED: 'ឡើងថ្នាក់',
  REPEATING: 'ត្រួតថ្នាក់',
};

const MONTHS_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const DIGITS_KM = '០១២៣៤៥៦៧៨៩';

/** "12.5" → "១២.៥" (any value; non-digits are kept) */
export const khmerDigits = (value: string | number) => String(value).replace(/[0-9]/g, (d) => DIGITS_KM[Number(d)]);

/** 2026-10-20 → "២០ តុលា ២០២៦" (dates are stored as UTC midnight) */
export const khmerDate = (date: Date) =>
  `${khmerDigits(date.getUTCDate())} ${MONTHS_KM[date.getUTCMonth()]} ${khmerDigits(date.getUTCFullYear())}`;

/** Today as "ថ្ងៃទី២០ ខែតុលា ឆ្នាំ២០២៦", for the signature line of a report */
export const khmerToday = (now = new Date()) =>
  `ថ្ងៃទី${khmerDigits(now.getDate())} ខែ${MONTHS_KM[now.getMonth()]} ឆ្នាំ${khmerDigits(now.getFullYear())}`;

/** A score for print: at most two decimals, trailing zeros dropped, Khmer digits */
export const khmerScore = (value: number) => khmerDigits(Number(value.toFixed(2)).toString());
