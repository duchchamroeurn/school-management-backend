// latinName of the seeded system roles that the code relies on
export const SYSTEM_ROLES = {
  SYSTEM_ADMIN: 'System Admin',
  // Reserved for student logins; staff logins can never hold it and student logins hold only it
  STUDENT: 'Student',
} as const;
