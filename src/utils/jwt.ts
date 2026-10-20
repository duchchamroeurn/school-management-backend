import jwt from 'jsonwebtoken';

export interface AccessTokenPayload {
  sub: string; // user id
  iat: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return secret;
}

const expiresIn = (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'];

export const signAccessToken = (userId: string) => jwt.sign({}, getSecret(), { subject: userId, expiresIn });

export const verifyAccessToken = (token: string) => jwt.verify(token, getSecret()) as AccessTokenPayload;
