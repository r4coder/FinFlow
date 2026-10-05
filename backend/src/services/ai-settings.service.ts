import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db';
import { AuthContext } from '../middleware/auth';
import { GeminiProvider } from '../ai/gemini.provider';
import { CredentialService } from '../security/credential.service';
import { maskSecret } from '../security/crypto';
import { badRequest } from '../utils/errors';
import { audit } from './audit.service';

export const UpdateAiSchema = z.object({
  mode: z.enum(['MOCK', 'GEMINI']),
  apiKey: z.string().trim().min(20, 'API key looks too short').max(200).optional(),
  model: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9._-]+$/).optional(),
});

/** NEVER returns the key; only whether one exists and a masked hint. */
export async function getAiSettings(organizationId: string) {
  const s = await prisma.organizationSettings.findUnique({ where: { organizationId } });
  const hint = await CredentialService.getHint(organizationId, 'gemini');
  return { provider: 'gemini', mode: s?.aiMode ?? 'MOCK', model: s?.aiModel ?? env.AI_MODEL, hasKey: Boolean(hint), maskedKey: maskSecret(hint) };
}

export async function validateKey(apiKey: string) {
  return GeminiProvider.validateKey(apiKey);
}

export async function updateAiSettings(a: AuthContext, input: z.infer<typeof UpdateAiSchema>) {
  const existingHint = await CredentialService.getHint(a.organizationId, 'gemini');
  if (input.mode === 'GEMINI' && !input.apiKey && !existingHint) throw badRequest('Enter and validate a Gemini API key before enabling Gemini mode', 'API_KEY_REQUIRED');
  if (input.apiKey) {
    const check = await GeminiProvider.validateKey(input.apiKey);
    if (!check.valid) throw badRequest(check.reason ?? 'The API key could not be validated', 'INVALID_AI_KEY');
    await CredentialService.storeCredential(a.organizationId, 'gemini', input.apiKey, a.userId);
    await audit({ organizationId: a.organizationId, action: 'ai.key_changed', entityType: 'settings', userId: a.userId, userName: a.fullName, metadata: { provider: 'gemini' } });
  }
  await prisma.organizationSettings.upsert({
    where: { organizationId: a.organizationId },
    create: { organizationId: a.organizationId, aiMode: input.mode, aiModel: input.model ?? env.AI_MODEL },
    update: { aiMode: input.mode, ...(input.model ? { aiModel: input.model } : {}) },
  });
  await prisma.onboarding.updateMany({ where: { organizationId: a.organizationId }, data: { aiConfigured: true } });
  await audit({ organizationId: a.organizationId, action: 'ai.mode_changed', entityType: 'settings', userId: a.userId, userName: a.fullName, metadata: { mode: input.mode, model: input.model } });
  return getAiSettings(a.organizationId);
}

export async function deleteAiKey(a: AuthContext) {
  await CredentialService.deleteCredential(a.organizationId, 'gemini');
  await prisma.organizationSettings.updateMany({ where: { organizationId: a.organizationId }, data: { aiMode: 'MOCK' } });
  await audit({ organizationId: a.organizationId, action: 'ai.key_deleted', entityType: 'settings', userId: a.userId, userName: a.fullName, metadata: { provider: 'gemini' } });
  return getAiSettings(a.organizationId);
}
