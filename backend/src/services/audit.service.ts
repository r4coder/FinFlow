import { Db, prisma } from '../db';

const SENSITIVE = /(key|secret|password|token|authorization|ciphertext|hash)/i;

/** Recursively drop anything that looks like a secret before it reaches the audit log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  return value;
}

export interface AuditInput {
  organizationId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  invoiceId?: string | null;
  userId?: string | null;
  userName?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(input: AuditInput, db: Db = prisma) {
  await db.auditLog.create({
    data: {
      organizationId: input.organizationId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      invoiceId: input.invoiceId ?? null,
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      metadata: input.metadata ? (redact(input.metadata) as any) : undefined,
    },
  });
}
