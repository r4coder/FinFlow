import { prisma } from '../db';
import { env } from '../config/env';
import { CredentialService } from '../security/credential.service';
import { GeminiProvider } from './gemini.provider';
import { MockAIProvider } from './mock.provider';
import { AIProvider, AIProviderError } from './types';

/**
 * Resolves the AI provider for an organization.
 * - mode MOCK   -> deterministic mock provider
 * - mode GEMINI -> real Gemini (requires a stored key). If no key exists we FAIL loudly instead of silently
 *   falling back to mock data, so a Gemini-mode result is never fake.
 */
export async function getProviderForOrg(organizationId: string): Promise<AIProvider> {
  const settings = await prisma.organizationSettings.findUnique({ where: { organizationId } });
  const mode = settings?.aiMode ?? (env.AI_MODE === 'gemini' ? 'GEMINI' : 'MOCK');
  if (mode === 'MOCK') return new MockAIProvider();
  const key = await CredentialService.getCredential(organizationId, 'gemini');
  if (!key) throw new AIProviderError('AI mode is Gemini but no API key is configured (Settings → AI)', false);
  return new GeminiProvider(key, settings?.aiModel || env.AI_MODEL);
}
