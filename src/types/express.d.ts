export interface AuthUser {
  id: string;
  username: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
  staffProfileId: string | null; // set for staff logins; scopes what a teacher may see and score
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
