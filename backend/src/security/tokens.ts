import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { Role } from '@prisma/client';

export interface AccessClaims {
  sub: string;
  org: string;
  role: Role;
}

export const signAccessToken = (claims: AccessClaims) =>
  jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as any });

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, env.JWT_SECRET) as unknown as AccessClaims;
}
