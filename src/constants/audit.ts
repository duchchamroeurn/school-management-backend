// Every action the audit log records, grouped by the entity it applies to. Services reference these
// via audit({ action: ... }), so a typo is a compile error; GET /audit-logs?action= accepts only these.
export const AUDIT_ACTIONS = {
  User: [
    'LOGIN_SUCCEEDED',
    'LOGIN_FAILED',
    'ACCOUNT_LOCKED',
    'PASSWORD_CHANGED',
    'PASSWORD_RESET',
    'USER_CREATED',
    'USER_ROLES_CHANGED',
    'USER_STATUS_CHANGED',
    'USER_DELETED',
  ],
  Role: ['ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_PERMISSIONS_CHANGED', 'ROLE_DELETED'],
  Enrollment: ['ENROLLMENT_CREATED', 'ENROLLMENT_TRANSFERRED', 'ENROLLMENT_DELETED'],
  Student: ['STUDENT_CREATED', 'STUDENT_UPDATED', 'STUDENT_DELETED'],
  Staff: ['STAFF_CREATED', 'STAFF_UPDATED', 'STAFF_DELETED'],
  ClassSection: ['CLASS_SECTION_CREATED', 'CLASS_SECTION_UPDATED', 'CLASS_SECTION_DELETED', 'HOMEROOM_ASSIGNED'],
  AcademicYear: ['ACADEMIC_YEAR_CREATED', 'ACADEMIC_YEAR_UPDATED', 'ACADEMIC_YEAR_DELETED'],
  Grade: ['GRADE_CREATED', 'GRADE_UPDATED', 'GRADE_DELETED'],
  Subject: ['SUBJECT_CREATED', 'SUBJECT_UPDATED', 'SUBJECT_DELETED', 'SUBJECT_GRADES_ASSIGNED', 'SUBJECT_GRADE_UNASSIGNED'],
  SchoolSettings: ['SCHOOL_SETTINGS_UPDATED'],
} as const;

export type AuditEntityType = keyof typeof AUDIT_ACTIONS;
export type AuditAction<E extends AuditEntityType = AuditEntityType> = (typeof AUDIT_ACTIONS)[E][number];

export const AUDIT_ENTITY_TYPES = Object.keys(AUDIT_ACTIONS) as AuditEntityType[];
export const ALL_AUDIT_ACTIONS = Object.values(AUDIT_ACTIONS).flat() as AuditAction[];
