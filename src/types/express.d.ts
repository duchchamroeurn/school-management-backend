export interface AuthUser {
  id: string;
  username: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
