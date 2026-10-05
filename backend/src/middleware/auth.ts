import type { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../utils/errors';
import { verifyAccessToken } from '../security/tokens';
import { can, Permission } from '../security/permissions';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
  fullName: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Authenticates the bearer token, then re-checks organization membership against the database so that
 * role changes and removals take effect immediately. The organization ID ALWAYS comes from here
 * (token + DB), never from the request body, query or URL.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    let claims;
    try {
      claims = verifyAccessToken(header.slice(7));
    } catch {
      throw unauthorized('Invalid or expired token', 'TOKEN_INVALID');
    }
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: claims.org, userId: claims.sub } },
      include: { user: true },
    });
    if (!member) throw unauthorized('Membership no longer valid', 'TOKEN_INVALID');
    req.auth = {
      userId: member.userId,
      organizationId: member.organizationId,
      role: member.role,
      email: member.user.email,
      fullName: member.user.fullName,
    };
    next();
  } catch (e) {
    next(e);
  }
}

export const requirePermission = (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth) return next(unauthorized());
  if (!can(req.auth.role, permission)) return next(forbidden());
  next();
};

export const auth = (req: Request) => {
  if (!req.auth) throw unauthorized();
  return req.auth;
};
