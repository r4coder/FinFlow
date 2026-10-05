import { Role } from '@prisma/client';
import { z } from 'zod';
import { env, isProduction } from '../config/env';
import { prisma } from '../db';
import { conflict, unauthorized, badRequest } from '../utils/errors';
import { hashPassword, passwordSchema, verifyPassword } from '../security/password';
import { randomToken, sha256 } from '../security/crypto';
import { signAccessToken } from '../security/tokens';
import { can, PERMISSIONS, Permission } from '../security/permissions';
import { audit } from './audit.service';
import { seedDefaultRules } from '../rules/rule.service';

export const RegisterSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    password: passwordSchema,
    confirmPassword: z.string(),
    companyName: z.string().trim().min(2).max(120),
    industry: z.string().trim().max(80).optional(),
    companySize: z.string().trim().max(40).optional(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

export const LoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

async function issueSession(userId: string, organizationId: string, role: Role) {
  const refreshToken = randomToken(48);
  await prisma.refreshToken.create({
    data: { userId, organizationId, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400000) },
  });
  return { accessToken: signAccessToken({ sub: userId, org: organizationId, role }), refreshToken };
}

/** Registration: organization, owner, settings, onboarding, default rules and audit entry are created in ONE transaction. */
export async function register(input: z.infer<typeof RegisterSchema>) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const passwordHash = await hashPassword(input.password);
  const { user, org } = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: input.companyName, slug: `${slugify(input.companyName)}-${randomToken(3)}`, industry: input.industry, companySize: input.companySize },
    });
    const user = await tx.user.create({ data: { email: input.email, passwordHash, fullName: input.fullName, lastLoginAt: new Date() } });
    await tx.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER' } });
    await tx.organizationSettings.create({ data: { organizationId: org.id, aiMode: env.AI_MODE === 'gemini' ? 'GEMINI' : 'MOCK', aiModel: env.AI_MODEL } });
    await tx.onboarding.create({ data: { organizationId: org.id } });
    await seedDefaultRules(org.id, { userId: user.id, fullName: user.fullName }, tx);
    await audit({ organizationId: org.id, action: 'organization.created', entityType: 'organization', entityId: org.id, userId: user.id, userName: user.fullName, metadata: { name: org.name } }, tx);
    return { user, org };
  });
  const session = await issueSession(user.id, org.id, 'OWNER');
  return { ...session, user: { id: user.id, email: user.email, fullName: user.fullName, role: 'OWNER' as Role, organization: { id: org.id, name: org.name } } };
}

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO5lYvDoE2e5H5v0a8m3rZ9X1Gm2k1wZy';

export async function login(input: z.infer<typeof LoginSchema>) {
  const user = await prisma.user.findUnique({ where: { email: input.email }, include: { memberships: { orderBy: { createdAt: 'asc' }, include: { organization: true } } } });
  const okPassword = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH); // constant-ish time
  if (!user || !okPassword || !user.memberships.length) throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  const m = user.memberships[0];
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ organizationId: m.organizationId, action: 'user.login', entityType: 'user', entityId: user.id, userId: user.id, userName: user.fullName });
  const session = await issueSession(user.id, m.organizationId, m.role);
  return { ...session, user: { id: user.id, email: user.email, fullName: user.fullName, role: m.role, organization: { id: m.organizationId, name: m.organization.name } } };
}

/** Rotating refresh tokens: each refresh revokes the old token and issues a new one. Reuse of a revoked token revokes the user's sessions. */
export async function refresh(token: string | undefined) {
  if (!token) throw unauthorized('No refresh token', 'NO_REFRESH_TOKEN');
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row) throw unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw unauthorized('Refresh token reuse detected; please sign in again', 'REFRESH_REUSE');
  }
  if (row.expiresAt < new Date()) throw unauthorized('Refresh token expired', 'INVALID_REFRESH_TOKEN');
  const member = await prisma.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: row.organizationId, userId: row.userId } } });
  if (!member) throw unauthorized('Membership no longer valid', 'INVALID_REFRESH_TOKEN');
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return issueSession(row.userId, row.organizationId, member.role);
}

export async function logout(token: string | undefined) {
  if (token) await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function me(userId: string, organizationId: string) {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { user: true, organization: { include: { onboarding: true, settings: true } } },
  });
  if (!member) throw unauthorized();
  return {
    id: member.user.id,
    email: member.user.email,
    fullName: member.user.fullName,
    role: member.role,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(member.role, p)),
    organization: { id: member.organization.id, name: member.organization.name, industry: member.organization.industry, companySize: member.organization.companySize },
    onboarding: member.organization.onboarding,
    aiMode: member.organization.settings?.aiMode ?? 'MOCK',
  };
}

export async function forgotPassword(emailRaw: string) {
  const email = z.string().trim().toLowerCase().email().parse(emailRaw);
  const user = await prisma.user.findUnique({ where: { email } });
  const generic = { message: 'If an account exists for that email, a reset link has been generated.' };
  if (!user) return generic;
  const token = randomToken(32);
  await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
  const link = `${env.FRONTEND_URL}/reset-password?token=${token}`;
  // No email provider is wired in: outside production the link is printed to the server log and returned to the caller
  // so the flow can be exercised locally. In production it is NOT returned (plug an email sender in here).
  if (!isProduction) {
    console.log(`[dev] password reset link for ${email}: ${link}`);
    return { ...generic, devResetLink: link };
  }
  console.warn('[auth] password reset requested but no email transport is configured');
  return generic;
}

export async function resetPassword(token: string, newPassword: string) {
  const pw = passwordSchema.parse(newPassword);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired', 'INVALID_RESET_TOKEN');
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(pw) } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}
