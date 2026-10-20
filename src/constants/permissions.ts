// Single source of truth for permission codes. The seed writes these to the `permissions` table
// and routes reference them via PERMISSIONS.<RESOURCE>.<ACTION>, so a typo is a compile error.
//
// Codes are VERB_NOUN: LIST_<plural>, VIEW_/CREATE_/UPDATE_/DELETE_<singular>.

const RESOURCES = {
  USER: { module: 'SYSTEM', plural: 'USERS', label: 'user logins' },
  ROLE: { module: 'SYSTEM', plural: 'ROLES', label: 'roles and their permissions' },
  STAFF: { module: 'HR', plural: 'STAFF', label: 'staff profiles' },
  STUDENT: { module: 'STUDENT_INTAKE', plural: 'STUDENTS', label: 'student profiles' },
  SUBJECT: { module: 'ACADEMIC', plural: 'SUBJECTS', label: 'subjects' },
  GRADE: { module: 'ACADEMIC', plural: 'GRADES', label: 'grade levels' },
  ACADEMIC_YEAR: { module: 'ACADEMIC', plural: 'ACADEMIC_YEARS', label: 'academic years' },
  CLASS_SECTION: { module: 'ACADEMIC', plural: 'CLASS_SECTIONS', label: 'class sections' },
  ENROLLMENT: { module: 'ENROLLMENT', plural: 'ENROLLMENTS', label: 'enrollments' },
} as const;

type Resource = keyof typeof RESOURCES;

type ResourceCodes<R extends Resource> = {
  LIST: `LIST_${(typeof RESOURCES)[R]['plural']}`;
  VIEW: `VIEW_${R}`;
  CREATE: `CREATE_${R}`;
  UPDATE: `UPDATE_${R}`;
  DELETE: `DELETE_${R}`;
};

const ACTION_VERBS = { LIST: 'List', VIEW: 'View a single record of', CREATE: 'Create', UPDATE: 'Update', DELETE: 'Delete' } as const;
type Action = keyof typeof ACTION_VERBS;

const codesFor = <R extends Resource>(resource: R): ResourceCodes<R> =>
  ({
    LIST: `LIST_${RESOURCES[resource].plural}`,
    VIEW: `VIEW_${resource}`,
    CREATE: `CREATE_${resource}`,
    UPDATE: `UPDATE_${resource}`,
    DELETE: `DELETE_${resource}`,
  }) as ResourceCodes<R>;

export const PERMISSIONS = {
  ...(Object.fromEntries(Object.keys(RESOURCES).map((r) => [r, codesFor(r as Resource)])) as {
    [R in Resource]: ResourceCodes<R>;
  }),
  SELF_SERVICE: { VIEW_OWN_PROFILE: 'VIEW_OWN_PROFILE', VIEW_OWN_HOMEROOM: 'VIEW_OWN_HOMEROOM' },
  // Single-row configuration: anyone signed in may read it, only this permission may change it
  SCHOOL_SETTINGS: { UPDATE: 'UPDATE_SCHOOL_SETTINGS' },
  // Read-only: the audit log is written by the API itself and can never be edited
  AUDIT_LOG: { LIST: 'LIST_AUDIT_LOGS' },
  // ENTER: only for subjects and classes the user teaches; ENTER_ANY: any subject and class (corrections)
  SCORE: { ENTER: 'ENTER_SCORES', ENTER_ANY: 'ENTER_ANY_SCORES' },
  // MARK / VIEW: only classes the user teaches (homeroom = daily, assigned subject = that subject); *_ANY: any class
  ATTENDANCE: { MARK: 'MARK_ATTENDANCE', MARK_ANY: 'MARK_ANY_ATTENDANCE', VIEW: 'VIEW_ATTENDANCE', VIEW_ANY: 'VIEW_ANY_ATTENDANCE' },
  // CREATE records a leave request (PENDING); REVIEW approves, rejects or cancels it
  LEAVE_REQUEST: { LIST: 'LIST_LEAVE_REQUESTS', CREATE: 'CREATE_LEAVE_REQUEST', REVIEW: 'REVIEW_LEAVE_REQUEST' },
  // Period results (average, mention, class rank) and report cards. Without _ANY: only the user's homeroom class
  RESULT: { CALCULATE: 'CALCULATE_RESULTS', CALCULATE_ANY: 'CALCULATE_ANY_RESULTS' },
  REPORT_CARD: { VIEW: 'VIEW_REPORT_CARDS', VIEW_ANY: 'VIEW_ANY_REPORT_CARDS' },
  // MANAGE: assessment periods and each subject's scoring rules per period; LOCK: finalise / reopen a period
  ASSESSMENT: { MANAGE: 'MANAGE_ASSESSMENT_RULES', LOCK: 'LOCK_ASSESSMENT_PERIODS' },
  // Rooms, the bell schedule (time slots) and every class's weekly timetable
  TIMETABLE: { MANAGE: 'MANAGE_TIMETABLE' },
} as const;

export type PermissionCode =
  | { [R in Resource]: ResourceCodes<R>[Action] }[Resource]
  | (typeof PERMISSIONS.SELF_SERVICE)[keyof typeof PERMISSIONS.SELF_SERVICE]
  | typeof PERMISSIONS.SCHOOL_SETTINGS.UPDATE
  | typeof PERMISSIONS.AUDIT_LOG.LIST
  | (typeof PERMISSIONS.SCORE)[keyof typeof PERMISSIONS.SCORE]
  | (typeof PERMISSIONS.ATTENDANCE)[keyof typeof PERMISSIONS.ATTENDANCE]
  | (typeof PERMISSIONS.LEAVE_REQUEST)[keyof typeof PERMISSIONS.LEAVE_REQUEST]
  | (typeof PERMISSIONS.RESULT)[keyof typeof PERMISSIONS.RESULT]
  | (typeof PERMISSIONS.REPORT_CARD)[keyof typeof PERMISSIONS.REPORT_CARD]
  | (typeof PERMISSIONS.ASSESSMENT)[keyof typeof PERMISSIONS.ASSESSMENT]
  | typeof PERMISSIONS.TIMETABLE.MANAGE;

export interface PermissionDefinition {
  module: string;
  code: PermissionCode;
  description: string;
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  ...(Object.keys(RESOURCES) as Resource[]).flatMap((resource) =>
    (Object.keys(ACTION_VERBS) as Action[]).map((action) => ({
      module: RESOURCES[resource].module,
      code: PERMISSIONS[resource][action] as PermissionCode,
      description: `${ACTION_VERBS[action]} ${RESOURCES[resource].label}`,
    })),
  ),
  { module: 'SELF_SERVICE', code: 'VIEW_OWN_PROFILE', description: 'View own profile and enrollment' },
  { module: 'SELF_SERVICE', code: 'VIEW_OWN_HOMEROOM', description: 'View the roster of the class one is homeroom teacher of' },
  { module: 'SYSTEM', code: 'UPDATE_SCHOOL_SETTINGS', description: 'Change school name, MoEYS code and school level (grades offered)' },
  { module: 'SYSTEM', code: 'LIST_AUDIT_LOGS', description: 'View the audit log of who changed what' },
  { module: 'ASSESSMENT', code: 'ENTER_SCORES', description: "Enter and correct scores for the subjects and classes one teaches" },
  { module: 'ASSESSMENT', code: 'ENTER_ANY_SCORES', description: 'Enter and correct scores for any subject and class, without a teaching assignment' },
  { module: 'ATTENDANCE', code: 'MARK_ATTENDANCE', description: 'Take attendance for one\'s own classes (daily as homeroom teacher, or one\'s assigned subjects)' },
  { module: 'ATTENDANCE', code: 'MARK_ANY_ATTENDANCE', description: 'Take or correct attendance for any class and subject' },
  { module: 'ATTENDANCE', code: 'VIEW_ATTENDANCE', description: 'View attendance of one\'s own classes' },
  { module: 'ATTENDANCE', code: 'VIEW_ANY_ATTENDANCE', description: 'View attendance of any class or student' },
  { module: 'ATTENDANCE', code: 'LIST_LEAVE_REQUESTS', description: 'View students\' leave requests' },
  { module: 'ATTENDANCE', code: 'CREATE_LEAVE_REQUEST', description: 'Record a student\'s leave request (pending until reviewed)' },
  { module: 'ATTENDANCE', code: 'REVIEW_LEAVE_REQUEST', description: 'Approve, reject or cancel leave requests' },
  { module: 'ASSESSMENT', code: 'CALCULATE_RESULTS', description: "Calculate period results (average, mention, rank) for one's homeroom class" },
  { module: 'ASSESSMENT', code: 'CALCULATE_ANY_RESULTS', description: 'Calculate period results for any class' },
  { module: 'ASSESSMENT', code: 'VIEW_REPORT_CARDS', description: "Print report cards for one's homeroom class" },
  { module: 'ASSESSMENT', code: 'VIEW_ANY_REPORT_CARDS', description: 'Print report cards for any class' },
  { module: 'ASSESSMENT', code: 'MANAGE_ASSESSMENT_RULES', description: 'Create assessment periods and set how each subject is scored in them' },
  { module: 'ACADEMIC', code: 'MANAGE_TIMETABLE', description: 'Manage rooms, the bell schedule and class timetables' },
  { module: 'ASSESSMENT', code: 'LOCK_ASSESSMENT_PERIODS', description: 'Lock a period so its scores and results are final, or reopen it' },
];

export const ALL_PERMISSION_CODES: PermissionCode[] = PERMISSION_DEFINITIONS.map((p) => p.code);

// Helpers for building role grants
export const readOnly = (...resources: Resource[]): PermissionCode[] =>
  resources.flatMap((r) => [PERMISSIONS[r].LIST, PERMISSIONS[r].VIEW]);

export const fullAccess = (...resources: Resource[]): PermissionCode[] =>
  resources.flatMap((r) => Object.values(PERMISSIONS[r]) as PermissionCode[]);
