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
  // GUARDIAN_*: a guardian linked to / unlinked from the student, or the link changed (relationship, primary contact)
  // *_REPLACED: before/after hold the stored file's id, size and checksum
  Student: [
    'STUDENT_CREATED',
    'STUDENT_UPDATED',
    'STUDENT_DELETED',
    'STUDENT_PHOTO_REPLACED',
    'STUDENT_BIRTH_CERTIFICATE_REPLACED',
    'GUARDIAN_LINKED',
    'GUARDIAN_LINK_UPDATED',
    'GUARDIAN_UNLINKED',
  ],
  Guardian: ['GUARDIAN_CREATED', 'GUARDIAN_UPDATED', 'GUARDIAN_DELETED'],
  Staff: ['STAFF_CREATED', 'STAFF_UPDATED', 'STAFF_DELETED'],
  // CLASS_PROMOTED: end-of-year promotion of the class (after = counts and targets; each enrollment is audited too)
  ClassSection: ['CLASS_SECTION_CREATED', 'CLASS_SECTION_UPDATED', 'CLASS_SECTION_DELETED', 'HOMEROOM_ASSIGNED', 'CLASS_PROMOTED', 'RESULTS_CALCULATED'],
  TeachingAssignment: ['TEACHING_ASSIGNMENT_CREATED', 'TEACHING_ASSIGNMENT_UPDATED', 'TEACHING_ASSIGNMENT_DELETED'],
  AcademicYear: ['ACADEMIC_YEAR_CREATED', 'ACADEMIC_YEAR_UPDATED', 'ACADEMIC_YEAR_DELETED'],
  Grade: ['GRADE_CREATED', 'GRADE_UPDATED', 'GRADE_DELETED'],
  Subject: ['SUBJECT_CREATED', 'SUBJECT_UPDATED', 'SUBJECT_DELETED', 'SUBJECT_GRADES_ASSIGNED', 'SUBJECT_GRADE_UNASSIGNED', 'SUBJECT_QUOTA_SET'],
  SchoolSettings: ['SCHOOL_SETTINGS_UPDATED'],
  // entityId = "school-week"; before/after map each weekday to its morning / afternoon flags
  SchoolWeek: ['SCHOOL_WEEK_UPDATED'],
  CalendarEvent: ['CALENDAR_EVENT_CREATED', 'CALENDAR_EVENT_UPDATED', 'CALENDAR_EVENT_DELETED'],
  // before/after hold the text, dates and audience (role and class ids)
  Announcement: ['ANNOUNCEMENT_CREATED', 'ANNOUNCEMENT_UPDATED', 'ANNOUNCEMENT_DELETED'],
  // RULES_*: a subject's scoring rules (SubjectAssessmentConfig + components) in the period
  AssessmentPeriod: [
    'ASSESSMENT_PERIOD_CREATED',
    'ASSESSMENT_PERIOD_UPDATED',
    'ASSESSMENT_PERIOD_DELETED',
    'ASSESSMENT_PERIOD_LOCKED',
    'ASSESSMENT_PERIOD_UNLOCKED',
    'SUBJECT_RULES_SET',
    'SUBJECT_RULES_REMOVED',
    'SUBJECT_RULES_COPIED',
  ],
  Room: ['ROOM_CREATED', 'ROOM_UPDATED', 'ROOM_DELETED'],
  TimeSlot: ['TIME_SLOT_CREATED', 'TIME_SLOT_UPDATED', 'TIME_SLOT_DELETED'],
  // entityId = the class section; before/after hold the slot's subject and teacher
  Timetable: ['LESSON_SCHEDULED', 'LESSON_REMOVED'],
  // entityId = the MonthlyResult; the teacher's comment on a report card
  Result: ['RESULT_REMARKS_UPDATED'],
  // entityId = the MonthlySubjectScore; before/after hold the total and each component score
  SubjectScore: ['SUBJECT_SCORE_RECORDED'],
  // entityId = the class section; before/after map each student to their status (and whether leave excused it)
  Attendance: ['ATTENDANCE_MARKED'],
  // after.excusedAbsences / revertedAbsences = attendance records changed by approving / cancelling
  LeaveRequest: ['LEAVE_REQUEST_CREATED', 'LEAVE_REQUEST_APPROVED', 'LEAVE_REQUEST_REJECTED', 'LEAVE_REQUEST_CANCELLED'],
} as const;

export type AuditEntityType = keyof typeof AUDIT_ACTIONS;
export type AuditAction<E extends AuditEntityType = AuditEntityType> = (typeof AUDIT_ACTIONS)[E][number];

export const AUDIT_ENTITY_TYPES = Object.keys(AUDIT_ACTIONS) as AuditEntityType[];
export const ALL_AUDIT_ACTIONS = Object.values(AUDIT_ACTIONS).flat() as AuditAction[];
