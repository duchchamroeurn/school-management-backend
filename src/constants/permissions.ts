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
  TEACHING_ASSIGNMENT: { module: 'ACADEMIC', plural: 'TEACHING_ASSIGNMENTS', label: 'teaching assignments (who teaches which subject in which class)' },
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
} as const;

export type PermissionCode =
  | { [R in Resource]: ResourceCodes<R>[Action] }[Resource]
  | (typeof PERMISSIONS.SELF_SERVICE)[keyof typeof PERMISSIONS.SELF_SERVICE]
  | typeof PERMISSIONS.SCHOOL_SETTINGS.UPDATE
  | typeof PERMISSIONS.AUDIT_LOG.LIST
  | (typeof PERMISSIONS.SCORE)[keyof typeof PERMISSIONS.SCORE];

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
];

export const ALL_PERMISSION_CODES: PermissionCode[] = PERMISSION_DEFINITIONS.map((p) => p.code);

// Helpers for building role grants
export const readOnly = (...resources: Resource[]): PermissionCode[] =>
  resources.flatMap((r) => [PERMISSIONS[r].LIST, PERMISSIONS[r].VIEW]);

export const fullAccess = (...resources: Resource[]): PermissionCode[] =>
  resources.flatMap((r) => Object.values(PERMISSIONS[r]) as PermissionCode[]);
