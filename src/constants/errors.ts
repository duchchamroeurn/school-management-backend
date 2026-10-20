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
    (name: string, what: 'its classes' | 'its enrollments' | 'homeroom teachers') =>
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

  // ── Enrollments ─────────────────────────────────────────
  ENROLLMENT_NOT_FOUND: def(404, 'Enrollment not found'),
  CLASS_CAPACITY_REACHED: def(400, 'Class capacity reached.', {
    details: (maxCapacity: number, currentEnrollment: number) => ({ maxCapacity, currentEnrollment }),
  }),
  ALREADY_ENROLLED: def(409, (studentIdentifier?: string, yearName?: string) =>
    studentIdentifier ? `Student ${studentIdentifier} is already enrolled in academic year ${yearName}` : 'Student is already enrolled in this academic year',
  ),
  STUDENT_NOT_ACTIVE: def(409, (studentIdentifier: string, status: string) => `Student ${studentIdentifier} is ${status} and cannot be enrolled`),
  NOT_A_NEW_ADMISSION: def(
    409,
    (studentIdentifier: string) => `Student ${studentIdentifier} has previous enrollments; use promotion or repeating instead of NEW_ADMISSION`,
  ),
  NO_PREVIOUS_ENROLLMENT: def(409, (studentIdentifier: string) => `Student ${studentIdentifier} has no earlier enrollment; use NEW_ADMISSION`),
  SAME_CLASS_SECTION: def(400, 'Student is already in this class section'),

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

  // ── Self-service (/me) ──────────────────────────────────
  OWN_PROFILE_NOT_FOUND: def(404, 'Your login is not linked to a student or staff profile', { code: 'PROFILE_NOT_FOUND' }),
  OWN_STAFF_PROFILE_NOT_FOUND: def(404, 'Only staff logins have a homeroom class: your login is not linked to a staff profile', {
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
