import { prisma } from '../db';
import { decryptSecret, encryptSecret } from './crypto';

/**
 * Server-side credential vault. Secrets are AES-256-GCM encrypted at rest and are never returned from any API;
 * only a short "hint" (last 4 chars) is stored in plain text so the UI can show a masked value.
 */
export const CredentialService = {
  encryptCredential: encryptSecret,
  decryptCredential: decryptSecret,

  async storeCredential(organizationId: string, provider: string, plain: string, userId?: string) {
    const enc = encryptSecret(plain);
    const hint = plain.slice(-4);
    await prisma.credential.upsert({
      where: { organizationId_provider: { organizationId, provider } },
      create: { organizationId, provider, ...enc, hint, createdBy: userId },
      update: { ...enc, hint },
    });
  },

  async getCredential(organizationId: string, provider: string): Promise<string | null> {
    const row = await prisma.credential.findUnique({ where: { organizationId_provider: { organizationId, provider } } });
    return row ? decryptSecret(row) : null;
  },

  async getHint(organizationId: string, provider: string): Promise<string | null> {
    const row = await prisma.credential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
      select: { hint: true },
    });
    return row?.hint ?? null;
  },

  async deleteCredential(organizationId: string, provider: string) {
    await prisma.credential.deleteMany({ where: { organizationId, provider } });
  },
};
