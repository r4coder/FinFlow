import crypto from 'node:crypto';
import { env } from '../config/env';

const keyBytes = () => crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** AES-256-GCM authenticated encryption. */
export function encryptSecret(plain: string): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(p: EncryptedPayload): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(p.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(p.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(p.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Show only the last four characters of a secret. */
export function maskSecret(hint: string | null | undefined): string | null {
  if (!hint) return null;
  return `${'•'.repeat(12)}${hint}`;
}
