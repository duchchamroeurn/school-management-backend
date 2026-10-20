import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface AccessTokenPayload {
  sub: string; // user id
  iat: number;
}

export const signAccessToken = (userId: string) =>
  jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: config.jwtExpiresIn });

export const verifyAccessToken = (token: string) => jwt.verify(token, config.jwtSecret) as AccessTokenPayload;
