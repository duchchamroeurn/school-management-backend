// Every API error in one place: HTTP status, error code and message.
//
//   throw Errors.STUDENT_NOT_FOUND();
//   throw Errors.DUPLICATE_STUDENT(existing);
//   throw Errors.CLASS_CAPACITY_REACHED(maxCapacity, current);
//
// The key is the error's name; the `code` sent to clients defaults to the key. Several situations can
// share one client code (e.g. MISSING_TOKEN and INVALID_TOKEN both send UNAUTHENTICATED) so the API's
// error codes stay stable while each message lives here.
import { HttpError } from '../utils/httpError';

type Message<A extends unknown[]> = string | ((...args: A) => string);

interface ErrorDef<A extends unknown[] = any[]> {
  status: number;
  code?: string; // defaults to the key
  message: Message<A>;
  details?: (...args: A) => unknown;
}

const def = <A extends unknown[] = []>(
  status: number,
  message: Message<A>,
  extra: { code?: string; details?: (...args: A) => unknown } = {},
): ErrorDef<A> => ({ status, message, ...extra });

const fieldDetails = (field: string) => () => ({ field });

const minutes = (seconds: number) => {
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
};

const ERROR_DEFS = {
  // ── Generic ─────────────────────────────────────────────
  INVALID_FIELD: def(400, (field: string, problem: string) => `${field} ${problem}`, {
    code: 'VALIDATION_ERROR',
    details: (field: string) => ({ field }),
  }),
  INVALID_JSON: def(400, 'Request body is not valid JSON'),
  ROUTE_NOT_FOUND: def(404, (method: string, path: string) => `Route ${method} ${path} not found`, { code: 'NOT_FOUND' }),
  CONFLICT: def(409, 'Another change was made at the same time; please retry'),
  INTERNAL_ERROR: def(500, 'Something went wrong'),
  DATABASE_UNAVAILABLE: def(503, 'The database is not reachable', { code: 'SERVICE_UNAVAILABLE' }),
  SHUTTING_DOWN: def(503, 'The server is shutting down', { code: 'SERVICE_UNAVAILABLE' }),
  // Database constraint errors a service didn't translate itself (safety net in errorHandler)
  DUPLICATE: def(409, 'A record with these values already exists'),
  IN_USE: def(409, 'This record is referenced by other records'),
  RECORD_NOT_FOUND: def(404, 'Record not found', { code: 'NOT_FOUND' }),

  // ── Authentication & authorisation ──────────────────────
  MISSING_TOKEN: def(401, 'Missing bearer token', { code: 'UNAUTHENTICATED' }),
  INVALID_TOKEN: def(401, 'Invalid or expired token', { code: 'UNAUTHENTICATED' }),
  ACCOUNT_INACTIVE: def(401, 'Account is not active', { code: 'UNAUTHENTICATED' }),
  TOKEN_REVOKED: def(401, 'Token was issued before the last password change', { code: 'UNAUTHENTICATED' }),
  AUTH_REQUIRED: def(401, 'Authentication required', { code: 'UNAUTHENTICATED' }),
  PASSWORD_CHANGE_REQUIRED: def(403, 'You must change your password before continuing'),
  FORBIDDEN: def(403, 'You do not have permission to perform this action', { details: (missing: string[]) => ({ missing }) }),
  FORBIDDEN_ANY: def(403, 'You do not have permission to perform this action', {
    code: 'FORBIDDEN',
    details: (anyOf: string[]) => ({ requiresAnyOf: anyOf }),
  }),
  CREDENTIALS_REQUIRED: def(400, 'username and password are required', { code: 'VALIDATION_ERROR' }),
  PASSWORDS_REQUIRED: def(400, 'currentPassword and newPassword are required', { code: 'VALIDATION_ERROR' }),
  INVALID_CREDENTIALS: def(401, 'Invalid username or password'),
  WRONG_CURRENT_PASSWORD: def(401, 'Current password is incorrect', { code: 'INVALID_CREDENTIALS' }),
  ACCOUNT_SUSPENDED: def(403, 'This account is suspended'),
  // Both send details.retryAfterSeconds, which errorHandler also sends as a Retry-After header
  TOO_MANY_LOGIN_ATTEMPTS: def(429, (seconds: number) => `Too many failed login attempts from this address; try again in ${minutes(seconds)}`, {
    details: (retryAfterSeconds: number) => ({ retryAfterSeconds }),
  }),
  ACCOUNT_LOCKED: def(429, (seconds: number) => `Too many failed login attempts; this account is locked for ${minutes(seconds)}`, {
    details: (retryAfterSeconds: number) => ({ retryAfterSeconds }),
  }),
  WEAK_PASSWORD: def(400, (field: string, problems: string[]) => `${field} must contain ${problems.join(', ')}`, {
    details: (_field: string, problems: string[]) => problems,
  }),
  PASSWORD_UNCHANGED: def(400, 'New password must be different from the current password', { code: 'WEAK_PASSWORD' }),

  // ── School settings & grades ────────────────────────────
  KHMER_SCRIPT_REQUIRED: def(400, (field: string) => `${field} must be written in Khmer script`, {
    code: 'VALIDATION_ERROR',
    details: (field: string) => ({ field }),
  }),
  GRADE_NOT_FOUND: def(404, 'Grade not found'),
  GRADES_NOT_FOUND: def(404, 'One or more grades do not exist', { code: 'GRADE_NOT_FOUND', details: (missing: string[]) => ({ missing }) }),
  GRADE_EXISTS: def(409, (gradeNumber: number) => `Grade ${gradeNumber} already exists`),
  GRADE_IN_USE: def(409, (gradeNumber: number, classes: number) => `Grade ${gradeNumber} has ${classes} class section(s); delete those first`),
  GRADE_NOT_OFFERED: def(
    400,
    (gradeNumber: number, levelLabel: string, _allowedGrades: number[]) => `Grade ${gradeNumber} is not offered: this school is ${levelLabel}`,
    { details: (_n: number, _l: string, allowedGrades: number[]) => ({ allowedGrades }) },
  ),
  LEVEL_CHANGE_BLOCKED: def(
    409,
    (levelLabel: string, gradesInUse: { gradeNumber: number; classSections: number }[]) =>
      `Cannot switch to ${levelLabel}: grade(s) ${gradesInUse.map((g) => g.gradeNumber).join(', ')} still have class sections`,
    { details: (_label: string, gradesInUse: { gradeNumber: number; classSections: number }[]) => ({ gradesInUse }) },
  ),

  // ── Academic years ──────────────────────────────────────
  ACADEMIC_YEAR_NOT_FOUND: def(404, (name?: string) => (name ? `Academic year ${name} not found` : 'Academic year not found')),
  ACADEMIC_YEAR_REQUIRED: def(400, 'academicYear is required because no academic year is ACTIVE', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('academicYear'),
  }),
  YEAR_NAME_FORMAT: def(400, 'name must be two consecutive years, e.g. "2026-2027"', { code: 'VALIDATION_ERROR', details: fieldDetails('name') }),
  END_BEFORE_START: def(400, 'endDate must be after startDate', { code: 'VALIDATION_ERROR', details: fieldDetails('endDate') }),
  ACADEMIC_YEAR_EXISTS: def(409, (name: string) => `Academic year ${name} already exists`),
  ACTIVE_YEAR_EXISTS: def(409, (activeName: string) => `Academic year ${activeName} is already active; complete it first`),
  ACADEMIC_YEAR_IN_USE: def(
    409,
    (name: string, classes: number, enrollments: number) =>
      `Academic year ${name} has ${classes} class section(s) and ${enrollments} enrollment(s); it cannot be deleted`,
  ),
  ACADEMIC_YEAR_CLOSED: def(
    409,
    (name: string, what: 'its classes' | 'its enrollments' | 'homeroom teachers' | 'its scores' | 'its teaching assignments' | 'its attendance' | 'its assessment periods') =>
      `Academic year ${name} is completed; ${what} can no longer be changed`,
  ),
  CLASS_IN_OTHER_YEAR: def(
    400,
    (className: string, classYearName: string) => `Class ${className} belongs to academic year ${classYearName}, not the one requested`,
    { code: 'ACADEMIC_YEAR_MISMATCH' },
  ),
  CLASS_NOT_IN_YEAR: def(400, (className: string, yearName: string) => `Class ${className} does not belong to academic year ${yearName}`, {
    code: 'ACADEMIC_YEAR_MISMATCH',
  }),
  TRANSFER_OUTSIDE_YEAR: def(
    400,
    (yearName: string, className: string, targetYearName: string) =>
      `Transfers must stay within ${yearName}; class ${className} is in ${targetYearName}`,
    { code: 'ACADEMIC_YEAR_MISMATCH' },
  ),

  // ── Subjects ────────────────────────────────────────────
  SUBJECT_NOT_FOUND: def(404, 'Subject not found'),
  SUBJECT_CODE_EXISTS: def(409, (code: string) => `Subject code ${code} already exists`),
  SUBJECT_IN_USE: def(409, (name: string, gradeNumbers: number[]) => `${name} is assigned to grade(s) ${gradeNumbers.join(', ')}; unassign it first`),
  NOT_ASSIGNED: def(404, (subjectName: string, gradeNumber: number) => `${subjectName} is not assigned to grade ${gradeNumber}`),
  GRADE_IDS_REQUIRED: def(400, 'gradeIds must contain at least one grade id', { code: 'VALIDATION_ERROR', details: fieldDetails('gradeIds') }),

  // ── Class sections ──────────────────────────────────────
  CLASS_SECTION_NOT_FOUND: def(404, 'Class section not found'),
  HOMEROOM_CLASS_NOT_FOUND: def(404, 'Class section (homeroom) not found', { code: 'CLASS_SECTION_NOT_FOUND' }),
  SECTION_NAME_REQUIRED: def(400, 'sectionName is required', { code: 'VALIDATION_ERROR', details: fieldDetails('sectionName') }),
  CAPACITY_OUT_OF_RANGE: def(400, (max: number) => `maxCapacity must be a whole number between 1 and ${max}`, {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('maxCapacity'),
  }),
  CLASS_SECTION_EXISTS: def(409, (className: string, yearName: string) => `Class ${className} already exists for academic year ${yearName}`),
  CAPACITY_BELOW_ENROLLMENT: def(409, (enrolled: number) => `maxCapacity cannot be lower than the ${enrolled} student(s) already enrolled`),
  CLASS_SECTION_IN_USE: def(409, (className: string, enrolled: number) => `Class ${className} has ${enrolled} enrolled student(s); it cannot be deleted`),
  TEACHER_NOT_FOUND: def(404, 'Homeroom teacher (staff profile) not found'),
  TEACHER_ALREADY_ASSIGNED: def(
    409,
    (teacher: { latinName: string; khmerName: string }, className: string, yearName: string, _classSectionId: string) =>
      `${teacher.latinName} (${teacher.khmerName}) is already homeroom teacher of class ${className} in ${yearName}`,
    { details: (_t: unknown, _c: string, _y: string, classSectionId: string) => ({ classSectionId }) },
  ),

  // ── Teaching assignments ────────────────────────────────
  TEACHING_ASSIGNMENT_NOT_FOUND: def(404, 'Teaching assignment not found'),
  SUBJECT_ALREADY_TAUGHT: def(
    409,
    (subjectName: string, className: string, teacher: { latinName: string; khmerName: string }, _assignmentId: string) =>
      `${subjectName} in class ${className} is already taught by ${teacher.latinName} (${teacher.khmerName}); change that assignment instead`,
    { details: (_s: string, _c: string, _t: unknown, assignmentId: string) => ({ assignmentId }) },
  ),

  // ── Students ────────────────────────────────────────────
  STUDENT_NOT_FOUND: def(404, 'Student not found'),
  DUPLICATE_STUDENT: def(
    409,
    (existing: { id: string; studentIdentifier: string; khmerName: string; latinName: string; birthCertificateNo: string }) =>
      `Birth certificate ${existing.birthCertificateNo} is already registered to ${existing.studentIdentifier} ${existing.khmerName} (${existing.latinName})`,
    { details: (existing: { id: string; studentIdentifier: string }) => ({ existingStudentId: existing.id, studentIdentifier: existing.studentIdentifier }) },
  ),
  AGE_OUT_OF_RANGE: def(400, (min: number, max: number) => `dateOfBirth must give an age between ${min} and ${max} for this school`, {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('dateOfBirth'),
  }),
  STUDENT_HAS_HISTORY: def(
    409,
    (studentIdentifier: string, enrollments: number) =>
      `Student ${studentIdentifier} has ${enrollments} enrollment(s). Set status to DROPPED_OUT or GRADUATED instead of deleting.`,
  ),
  STUDENT_HAS_LOGIN: def(409, (studentIdentifier: string) => `Student ${studentIdentifier} has a login account; remove it first`),

  // ── Guardians ───────────────────────────────────────────
  GUARDIAN_NOT_FOUND: def(404, 'Guardian not found'),
  GUARDIAN_INPUT_REQUIRED: def(400, 'Send guardianId to link an existing guardian, or guardian { khmerName, latinName, … } to add a new one', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('guardian'),
  }),
  GUARDIAN_INPUT_AMBIGUOUS: def(400, 'Send guardianId or guardian, not both', { code: 'VALIDATION_ERROR', details: fieldDetails('guardian') }),
  GUARDIAN_ALREADY_LINKED: def(409, (guardianName: string, studentIdentifier: string) => `${guardianName} is already a guardian of student ${studentIdentifier}`),
  GUARDIAN_NOT_LINKED: def(404, (guardianName: string, studentIdentifier: string) => `${guardianName} is not a guardian of student ${studentIdentifier}`),
  TOO_MANY_GUARDIANS: def(409, (max: number) => `A student can have at most ${max} guardians`),
  GUARDIAN_HAS_STUDENTS: def(409, (guardianName: string, students: number) => `${guardianName} is the guardian of ${students} student(s); unlink them first`, {
    details: (_g: string, students: number) => ({ students }),
  }),

  // ── Enrollments ─────────────────────────────────────────
  ENROLLMENT_NOT_FOUND: def(404, 'Enrollment not found'),
  CLASS_CAPACITY_REACHED: def(400, 'Class capacity reached.', {
    details: (maxCapacity: number, currentEnrollment: number) => ({ maxCapacity, currentEnrollment }),
  }),
  ALREADY_ENROLLED: def(409, (studentIdentifier?: string, yearName?: string) =>
    studentIdentifier ? `Student ${studentIdentifier} is already enrolled in academic year ${yearName}` : 'Student is already enrolled in this academic year',
  ),
  STUDENT_NOT_ACTIVE: def(
    409,
    (studentIdentifier: string, status: string, action: string = 'enrolled') => `Student ${studentIdentifier} is ${status} and cannot be ${action}`,
  ),
  NOT_A_NEW_ADMISSION: def(
    409,
    (studentIdentifier: string) => `Student ${studentIdentifier} has previous enrollments; use promotion or repeating instead of NEW_ADMISSION`,
  ),
  NO_PREVIOUS_ENROLLMENT: def(409, (studentIdentifier: string) => `Student ${studentIdentifier} has no earlier enrollment; use NEW_ADMISSION`),
  SAME_CLASS_SECTION: def(400, 'Student is already in this class section'),

  // ── Rooms, time slots & timetable ───────────────────────
  ROOM_NOT_FOUND: def(404, 'Room not found'),
  ROOM_EXISTS: def(409, (name: string) => `A room named "${name}" already exists`),
  ROOM_IN_USE: def(409, (name: string, classes: number) => `${name} is the home room of ${classes} class(es); move them first`),
  ROOM_SHIFT_TAKEN: def(
    409,
    (room: string, shift: string, otherClass: string) => `${room} is already used by class ${otherClass} in the ${shift.toLowerCase()} shift`,
  ),
  CLASS_HAS_TIMETABLE: def(409, (className: string, lessons: number) => `Class ${className} has ${lessons} lesson(s) in its timetable; clear them before changing its shift`),
  TIME_SLOT_NOT_FOUND: def(404, 'Time slot not found'),
  TIME_SLOT_EXISTS: def(409, (label: string) => `There is already a time slot for ${label}`),
  TIME_SLOT_OVERLAP: def(409, (label: string, other: string) => `${label} overlaps ${other}`),
  TIME_SLOT_INVALID: def(400, 'endTime must be after startTime (both HH:MM, 24-hour)', { code: 'VALIDATION_ERROR', details: fieldDetails('endTime') }),
  TIME_SLOT_IN_USE: def(409, (label: string, lessons: number) => `${label} has ${lessons} lesson(s) scheduled; remove them first`),
  WRONG_SHIFT: def(400, (className: string, shift: string, slot: string) => `Class ${className} studies in the ${shift.toLowerCase()} shift, but ${slot} is not`),
  QUOTA_EXCEEDED: def(
    409,
    (subjectName: string, className: string, quota: number) => `${subjectName} already has its ${quota} lesson(s) per week in class ${className} (the MoEYS quota)`,
  ),
  TEACHER_CLASH: def(
    409,
    (teacherName: string, slot: string, otherClass: string) => `${teacherName} already teaches class ${otherClass} on ${slot}`,
    { details: (_t: string, _s: string, otherClass: string) => ({ otherClass }) },
  ),
  TEACHER_CLASHES: def(
    409,
    (teacherName: string, _clashes: { slot: string; otherClass: string }[]) =>
      `${teacherName} already teaches other classes at times this subject is scheduled; change the timetable first`,
    { code: 'TEACHER_CLASH', details: (_t: string, clashes: { slot: string; otherClass: string }[]) => ({ clashes }) },
  ),
  QUOTA_INVALID: def(400, 'weeklyPeriods must be a whole number from 0 to 20, or null', { code: 'VALIDATION_ERROR', details: fieldDetails('weeklyPeriods') }),

  // ── Assessment periods & rules ──────────────────────────
  ASSESSMENT_PERIOD_EXISTS: def(409, (name: string, yearName: string) => `A period named "${name}" already exists in ${yearName}`),
  PERIOD_OUTSIDE_YEAR: def(
    400,
    (yearName: string, start: string, end: string) => `The period must lie within academic year ${yearName} (${start} – ${end})`,
    { code: 'VALIDATION_ERROR', details: () => ({ field: 'startDate' }) },
  ),
  PERIOD_END_BEFORE_START: def(400, 'endDate must be on or after startDate', { code: 'VALIDATION_ERROR', details: fieldDetails('endDate') }),
  DEADLINE_BEFORE_START: def(400, 'scoreEntryDeadline must be on or after startDate', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('scoreEntryDeadline'),
  }),
  PERIOD_HAS_SCORES: def(
    409,
    (name: string, scores: number, results: number) => `${name} already has ${scores} score(s) and ${results} result(s); it cannot be deleted`,
  ),
  PERIOD_ALREADY_IN_STATE: def(409, (name: string, locked: boolean) => `${name} is already ${locked ? 'locked' : 'open'}`),
  RULES_HAVE_SCORES: def(
    409,
    (subjectName: string, periodName: string, scores: number) =>
      `${subjectName} already has ${scores} score(s) in ${periodName}; its scoring rules can no longer change`,
  ),
  NO_RULES_FOR_SUBJECT: def(404, (subjectName: string, periodName: string) => `${subjectName} has no scoring rules in ${periodName}`, {
    code: 'SUBJECT_ASSESSMENT_CONFIG_NOT_FOUND',
  }),
  COPY_FROM_SAME_PERIOD: def(400, 'Choose a different period to copy the rules from', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('fromAssessmentPeriodId'),
  }),
  SCORE_DEADLINE_PASSED: def(
    409,
    (periodName: string, deadline: string) => `The deadline for entering ${periodName} scores was ${deadline}; ask the principal to correct scores now`,
  ),

  // ── Period results & reports ────────────────────────────
  NOT_HOMEROOM_FOR_CLASS: def(403, (className: string, action: string) => `Only the homeroom teacher of class ${className} can ${action}`),
  PERIOD_NOT_IN_CLASS_YEAR: def(400, (periodName: string, className: string, yearName: string) => `${periodName} is not in ${yearName}, the year of class ${className}`, {
    code: 'ACADEMIC_YEAR_MISMATCH',
  }),
  NO_SUBJECTS_CONFIGURED: def(
    409,
    (periodName: string, gradeNumber: number) => `No subject of grade ${gradeNumber} has scoring rules for ${periodName}; set them up first`,
  ),
  SCORES_INCOMPLETE: def(
    409,
    (className: string, periodName: string, _missing: { studentIdentifier: string; latinName: string; subjects: string[] }[]) =>
      `Some students in class ${className} have no score yet for ${periodName}; enter every score before calculating`,
    { details: (_c: string, _p: string, missing: { studentIdentifier: string; latinName: string; subjects: string[] }[]) => ({ missing }) },
  ),
  RESULTS_NOT_CALCULATED: def(409, (className: string, periodName: string) => `Results for class ${className} in ${periodName} haven't been calculated yet`),
  STUDENT_NOT_IN_REPORT: def(404, 'That student has no result in this class for this period'),

  // ── End-of-year promotion ───────────────────────────────
  PROMOTION_YEAR_NOT_STARTED: def(409, (className: string, yearName: string) => `Class ${className} is in ${yearName}, which hasn't started; there is nothing to promote yet`),
  STUDENT_IN_BOTH_LISTS: def(400, 'A student cannot be both repeating and excluded', {
    code: 'VALIDATION_ERROR',
    details: (studentIds: string[]) => ({ field: 'repeatingStudentIds', studentIds }),
  }),
  // STUDENTS_NOT_IN_CLASS (shared with attendance) is defined below
  PROMOTED_CLASS_NOT_ALLOWED: def(
    400,
    (gradeNumber: number) => `Grade ${gradeNumber} is this school's top grade: promoted students graduate, so don't send promotedClassSectionId`,
    { code: 'VALIDATION_ERROR', details: () => ({ field: 'promotedClassSectionId' }) },
  ),
  PROMOTED_CLASS_REQUIRED: def(400, (count: number, nextGrade: number) => `${count} student(s) are promoted: send promotedClassSectionId, a grade ${nextGrade} class`, {
    code: 'VALIDATION_ERROR',
    details: () => ({ field: 'promotedClassSectionId' }),
  }),
  REPEATING_CLASS_REQUIRED: def(400, (count: number, gradeNumber: number) => `${count} student(s) repeat: send repeatingClassSectionId, a grade ${gradeNumber} class`, {
    code: 'VALIDATION_ERROR',
    details: () => ({ field: 'repeatingClassSectionId' }),
  }),
  TARGET_CLASS_WRONG_GRADE: def(
    400,
    (role: 'promoted' | 'repeating', className: string, expectedGrade: number) =>
      `The ${role} class must be in grade ${expectedGrade}, but ${className} is not`,
    { code: 'VALIDATION_ERROR', details: (role: 'promoted' | 'repeating') => ({ field: `${role}ClassSectionId` }) },
  ),
  TARGET_YEAR_NOT_LATER: def(
    400,
    (className: string, targetYear: string, sourceYear: string) => `Class ${className} is in ${targetYear}; students can only move to a year after ${sourceYear}`,
    { code: 'VALIDATION_ERROR' },
  ),
  TARGET_CLASSES_DIFFERENT_YEARS: def(
    400,
    (promotedYear: string, repeatingYear: string) => `The promoted class is in ${promotedYear} but the repeating class is in ${repeatingYear}; use classes of the same year`,
    { code: 'VALIDATION_ERROR' },
  ),

  // ── Staff ───────────────────────────────────────────────
  STAFF_NOT_FOUND: def(404, 'Staff member not found'),
  DUPLICATE_STAFF: def(
    409,
    (existing: { id: string; nationalIdNo: string; khmerName: string; latinName: string }) =>
      `National ID ${existing.nationalIdNo} is already registered to ${existing.latinName} (${existing.khmerName})`,
    { details: (existing: { id: string }) => ({ existingStaffId: existing.id }) },
  ),
  HIRE_DATE_IN_FUTURE: def(400, 'hireDate cannot be in the future', { code: 'VALIDATION_ERROR', details: fieldDetails('hireDate') }),
  STAFF_HAS_HOMEROOM: def(409, (name: string, classes: number) => `${name} is homeroom teacher of ${classes} class(es); unassign them first`),
  STAFF_HAS_LOGIN: def(409, (name: string) => `${name} has a login account; remove it first`),
  STAFF_HAS_TEACHING: def(409, (name: string, assignments: number) => `${name} has ${assignments} teaching assignment(s); remove them first`),

  // ── Users (logins) ──────────────────────────────────────
  USER_NOT_FOUND: def(404, 'User not found'),
  PROFILE_MISSING: def(400, 'A login must belong to a profile: send staffId or studentId (orphan accounts are not allowed)', {
    code: 'PROFILE_REQUIRED',
  }),
  PROFILE_AMBIGUOUS: def(400, 'A login belongs to one profile: send staffId OR studentId, not both', { code: 'PROFILE_REQUIRED' }),
  PROFILE_HAS_LOGIN: def(
    409,
    (profileType: string, username: string | undefined, _existingUserId: string) => `This ${profileType} profile already has a login (${username})`,
    { details: (_p: string, _u: string | undefined, existingUserId: string) => ({ existingUserId }) },
  ),
  USERNAME_TAKEN: def(409, (username: string) => `Username ${username} is already taken`),
  STAFF_ROLE_REQUIRED: def(400, 'roleIds must contain at least one role for a staff login', { code: 'VALIDATION_ERROR', details: fieldDetails('roleIds') }),
  STUDENT_ROLE_ONLY: def(400, 'Student logins can only have the Student role', { code: 'INVALID_ROLE' }),
  STUDENT_ROLE_RESERVED: def(400, 'The Student role is reserved for student logins', { code: 'INVALID_ROLE' }),
  LAST_SYSTEM_ADMIN: def(409, (action: string, username: string) => `Cannot ${action}: ${username} is the last active System Admin`),
  CANNOT_MODIFY_SELF: def(400, (action: string) => `You cannot ${action} your own account`),

  // ── Assessment (grading rules) ──────────────────────────
  SUBJECT_ASSESSMENT_CONFIG_NOT_FOUND: def(404, 'Subject assessment config not found'),
  MAX_TOTAL_SCORE_INVALID: def(400, 'maxTotalScore must be greater than 0', { code: 'VALIDATION_ERROR', details: fieldDetails('maxTotalScore') }),
  COMPONENT_MAX_SCORE_INVALID: def(400, (name: string) => `Component "${name}" must have a maxScore greater than 0`, {
    code: 'VALIDATION_ERROR',
    details: (name: string) => ({ field: 'components.maxScore', component: name }),
  }),
  DUPLICATE_COMPONENT_NAME: def(400, (name: string) => `Component name "${name}" is used more than once`, {
    code: 'VALIDATION_ERROR',
    details: (name: string) => ({ field: 'components.name', component: name }),
  }),
  COMPONENTS_REQUIRED: def(400, 'A component-based subject needs at least one component', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('components'),
  }),
  COMPONENTS_NOT_ALLOWED: def(400, 'This subject is not component-based, so it cannot have components; set isComponentBased to true', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('components'),
  }),
  COMPONENT_TOTAL_MISMATCH: def(
    400,
    (maxTotalScore: number, componentTotal: number) =>
      `The components' maxScore values add up to ${componentTotal}, but maxTotalScore is ${maxTotalScore}; they must be equal`,
    {
      details: (maxTotalScore: number, componentTotal: number) => ({
        maxTotalScore,
        componentTotal,
        difference: Math.round((maxTotalScore - componentTotal) * 100) / 100,
      }),
    },
  ),

  // ── Score entry ─────────────────────────────────────────
  ASSESSMENT_PERIOD_NOT_FOUND: def(404, 'Assessment period not found'),
  NO_ASSESSMENT_CONFIG: def(
    404,
    (subjectName: string, periodName: string) => `${subjectName} has no scoring rules for ${periodName}; set them up before entering scores`,
    { code: 'SUBJECT_ASSESSMENT_CONFIG_NOT_FOUND' },
  ),
  PERIOD_LOCKED: def(409, (periodName: string, yearName: string) => `${periodName} ${yearName} is locked; its scores can no longer change`),
  STUDENT_NOT_ENROLLED_IN_YEAR: def(409, (studentIdentifier: string, yearName: string) => `Student ${studentIdentifier} is not enrolled in academic year ${yearName}`),
  STUDENT_NOT_IN_CLASS: def(400, (studentIdentifier: string, actualClass: string) => `Student ${studentIdentifier} is not in that class; they are in ${actualClass}`, {
    code: 'VALIDATION_ERROR',
    details: (_s: string, actualClass: string) => ({ field: 'classSectionId', actualClass }),
  }),
  SUBJECT_NOT_IN_GRADE: def(400, (subjectName: string, gradeNumber: number) => `${subjectName} is not taught in grade ${gradeNumber}`),
  NOT_TEACHING_SUBJECT: def(
    403,
    (subjectName: string, className: string) => `You don't teach ${subjectName} in class ${className}, so you can't enter its scores`,
  ),
  TOTAL_SCORE_REQUIRED: def(400, (subjectName: string, periodName: string) => `${subjectName} is scored directly in ${periodName}: send totalScoreAchieved`, {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('totalScoreAchieved'),
  }),
  COMPONENTS_NOT_EXPECTED: def(
    400,
    (subjectName: string, periodName: string) => `${subjectName} is scored directly in ${periodName}: send totalScoreAchieved, not components`,
    { code: 'VALIDATION_ERROR', details: fieldDetails('components') },
  ),
  COMPONENT_SCORES_REQUIRED: def(
    400,
    (subjectName: string, periodName: string) => `${subjectName} is component-based in ${periodName}: send a score for each component`,
    { code: 'VALIDATION_ERROR', details: fieldDetails('components') },
  ),
  TOTAL_NOT_EXPECTED: def(
    400,
    (subjectName: string, periodName: string) =>
      `${subjectName} is component-based in ${periodName}: the total is calculated from the components, so don't send totalScoreAchieved`,
    { code: 'VALIDATION_ERROR', details: fieldDetails('totalScoreAchieved') },
  ),
  COMPONENTS_MISMATCH: def(
    400,
    (_unknown: string[], _duplicated: string[], _missing: { componentId: string; name: string }[]) =>
      "The components sent don't match this month's components: send each one exactly once",
    {
      details: (
        unknown: string[],
        duplicated: string[],
        missing: { componentId: string; name: string }[],
      ) => ({ unknown, duplicated, missing }),
    },
  ),
  SCORE_OUT_OF_RANGE: def(400, (label: string, maxScore: number, _componentId?: string) => `${label} must be between 0 and ${maxScore}`, {
    details: (_label: string, maxScore: number, componentId?: string) => ({ maxScore, ...(componentId && { componentId }) }),
  }),

  // ── Self-service (/me) ──────────────────────────────────
  OWN_PROFILE_NOT_FOUND: def(404, 'Your login is not linked to a student or staff profile', { code: 'PROFILE_NOT_FOUND' }),
  OWN_STAFF_PROFILE_NOT_FOUND: def(404, 'This is only for staff logins: your login is not linked to a staff profile', {
    code: 'PROFILE_NOT_FOUND',
  }),
  NO_HOMEROOM_CLASS: def(404, (yearName: string) => `You are not the homeroom teacher of any class in academic year ${yearName}`),

  // ── Roles & permissions ─────────────────────────────────
  ROLE_NOT_FOUND: def(404, 'Role not found'),
  ROLES_NOT_FOUND: def(404, 'One or more roles do not exist', { code: 'ROLE_NOT_FOUND', details: (missing: string[]) => ({ missing }) }),
  ROLE_NAME_EXISTS: def(409, (name: string) => `A role named "${name}" already exists`),
  SYSTEM_ROLE_IMMUTABLE: def(409, (name: string) => `${name} is a system role and cannot be changed or deleted; create a custom role instead`),
  ROLE_IN_USE: def(409, (name: string, users: number) => `${name} is assigned to ${users} user(s); change their roles first`, {
    details: (_name: string, users: number) => ({ users }),
  }),
  UNKNOWN_PERMISSION: def(400, 'One or more permission codes do not exist — see GET /api/v1/permissions', {
    details: (unknown: string[]) => ({ unknown }),
  }),
  PERMISSION_CODES_REQUIRED: def(400, 'permissionCodes must contain at least one permission', {
    code: 'VALIDATION_ERROR',
    details: fieldDetails('permissionCodes'),
  }),
  CANNOT_GRANT_PERMISSION: def(403, 'You can only grant permissions you hold yourself', { details: (notHeld: string[]) => ({ notHeld }) }),

  // ── Attendance ──────────────────────────────────────────
  ATTENDANCE_RECORDS_REQUIRED: def(400, 'records must contain at least one student', { code: 'VALIDATION_ERROR', details: fieldDetails('records') }),
  DUPLICATE_STUDENTS_IN_REQUEST: def(400, 'Each student may appear only once in records', {
    code: 'VALIDATION_ERROR',
    details: (duplicated: string[]) => ({ field: 'records', duplicated }),
  }),
  ATTENDANCE_DATE_IN_FUTURE: def(400, (date: string) => `Attendance can't be recorded for a future date (${date})`, {
    code: 'ATTENDANCE_DATE_INVALID',
    details: fieldDetails('date'),
  }),
  ATTENDANCE_DATE_OUTSIDE_YEAR: def(
    400,
    (date: string, yearName: string, start: string, end: string) => `${date} is outside academic year ${yearName} (${start} – ${end})`,
    { code: 'ATTENDANCE_DATE_INVALID', details: fieldDetails('date') },
  ),
  STUDENTS_NOT_IN_CLASS: def(
    400,
    (className: string, _studentIds: string[]) => `Some students are not currently enrolled in class ${className}`,
    { details: (_c: string, studentIds: string[]) => ({ studentIds }) },
  ),
  NOT_HOMEROOM_TEACHER: def(403, (className: string) => `Only the homeroom teacher of class ${className} can take its daily attendance`),
  NOT_CLASS_TEACHER: def(403, (className: string) => `You can only view attendance of classes you teach; you don't teach class ${className}`),
  LEAVE_REQUEST_NOT_FOUND: def(404, 'Leave request not found'),
  LEAVE_DATES_INVALID: def(400, 'endDate must be on or after startDate', { code: 'VALIDATION_ERROR', details: fieldDetails('endDate') }),
  LEAVE_TOO_LONG: def(400, (maxDays: number) => `A leave request can cover at most ${maxDays} days`, { code: 'VALIDATION_ERROR', details: fieldDetails('endDate') }),
  LEAVE_OVERLAP: def(
    409,
    (existing: { id: string; status: string; startDate: string; endDate: string }) =>
      `The student already has a ${existing.status.toLowerCase()} leave request for ${existing.startDate} – ${existing.endDate}`,
    { details: (existing: { id: string }) => ({ existingLeaveRequestId: existing.id }) },
  ),
  LEAVE_STATUS_INVALID: def(409, (status: string, action: string) => `A ${status.toLowerCase()} leave request can't be ${action}`),
  NOT_TEACHING_SUBJECT_ATTENDANCE: def(
    403,
    (subjectName: string, className: string) => `You don't teach ${subjectName} in class ${className}, so you can't take its attendance`,
    { code: 'NOT_TEACHING_SUBJECT' },
  ),
} satisfies Record<string, ErrorDef>;

type ErrorDefs = typeof ERROR_DEFS;
type ArgsOf<D> = D extends ErrorDef<infer A> ? A : never;

export const Errors = Object.fromEntries(
  Object.entries(ERROR_DEFS).map(([key, d]: [string, ErrorDef]) => [
    key,
    (...args: unknown[]) =>
      new HttpError(d.status, d.code ?? key, typeof d.message === 'function' ? d.message(...args) : d.message, d.details?.(...args)),
  ]),
) as { [K in keyof ErrorDefs]: (...args: ArgsOf<ErrorDefs[K]>) => HttpError };

// Every code a client can receive (e.g. for frontend translations / docs)
export const ERROR_CODES = [...new Set(Object.entries(ERROR_DEFS).map(([key, d]: [string, ErrorDef]) => d.code ?? key))].sort();
export type ErrorName = keyof ErrorDefs;
