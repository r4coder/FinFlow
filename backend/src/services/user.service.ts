import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { AuthContext } from '../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { hashPassword, passwordSchema } from '../security/password';
import { ROLE_RANK } from '../security/permissions';
import { audit } from './audit.service';

export const CreateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  role: z.nativeEnum(Role),
});

export async function listUsers(organizationId: string) {
  const m = await prisma.organizationMember.findMany({ where: { organizationId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
  return m.map((x) => ({ id: x.userId, email: x.user.email, fullName: x.user.fullName, role: x.role, lastLoginAt: x.user.lastLoginAt, createdAt: x.createdAt }));
}

function assertCanAssign(actor: AuthContext, role: Role) {
  if (role === 'OWNER' && actor.role !== 'OWNER') throw forbidden('Only an owner can assign the OWNER role');
  if (ROLE_RANK[role] > ROLE_RANK[actor.role]) throw forbidden('You cannot assign a role above your own');
}

export async function createUser(a: AuthContext, input: z.infer<typeof CreateUserSchema>) {
  assertCanAssign(a, input.role);
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict('A user with this email already exists', 'EMAIL_TAKEN');
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { email: input.email, fullName: input.fullName, passwordHash: await hashPassword(input.password) } });
    await tx.organizationMember.create({ data: { organizationId: a.organizationId, userId: u.id, role: input.role } });
    await audit({ organizationId: a.organizationId, action: 'user.created', entityType: 'user', entityId: u.id, userId: a.userId, userName: a.fullName, metadata: { email: u.email, role: input.role } }, tx);
    return u;
  });
  return { id: user.id, email: user.email, fullName: user.fullName, role: input.role };
}

export async function changeRole(a: AuthContext, userId: string, role: Role) {
  const target = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: a.organizationId, userId } } });
  if (!target) throw notFound('User not found');
  if (userId === a.userId) throw badRequest('You cannot change your own role', 'SELF_ROLE_CHANGE');
  assertCanAssign(a, role);
  if (target.role === 'OWNER' && a.role !== 'OWNER') throw forbidden('Only an owner can change an owner');
  if (target.role === 'OWNER' && role !== 'OWNER') {
    const owners = await prisma.organizationMember.count({ where: { organizationId: a.organizationId, role: 'OWNER' } });
    if (owners <= 1) throw badRequest('The organization must keep at least one owner', 'LAST_OWNER');
  }
  await prisma.organizationMember.update({ where: { id: target.id }, data: { role } });
  await audit({ organizationId: a.organizationId, action: 'user.role_changed', entityType: 'user', entityId: userId, userId: a.userId, userName: a.fullName, metadata: { from: target.role, to: role } });
  return { id: userId, role };
}

export async function removeUser(a: AuthContext, userId: string) {
  const target = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: a.organizationId, userId } } });
  if (!target) throw notFound('User not found');
  if (userId === a.userId) throw badRequest('You cannot remove yourself', 'SELF_REMOVE');
  if (target.role === 'OWNER') throw forbidden('Owners cannot be removed');
  await prisma.organizationMember.delete({ where: { id: target.id } });
  await prisma.refreshToken.updateMany({ where: { userId, organizationId: a.organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit({ organizationId: a.organizationId, action: 'user.removed', entityType: 'user', entityId: userId, userId: a.userId, userName: a.fullName });
}
