import { Role } from '@prisma/client';
import { Tx } from '../db';
import { notifyUser, usersWithRole } from '../notifications/notification.service';

export interface ChainInput {
  tx: Tx;
  organizationId: string;
  invoice: { id: string; invoiceNumber: string | null; uploadedBy: string | null };
  levels: { role?: string; userId?: string }[];
  ruleId: string | null;
  runKey: string;
  requestedBy?: string | null;
  reasonNote?: string;
}

/**
 * Creates the approval chain for an invoice. Level 1 is PENDING, later levels WAITING.
 * Idempotent: the unique key (invoiceId, runKey, ruleKey, level) + skipDuplicates means a retried job never creates
 * duplicate approvals or notifications.
 */
export async function createApprovalChain(c: ChainInput): Promise<{ created: number }> {
  const ruleKey = c.ruleId ?? 'system';
  const data = c.levels.map((l, i) => ({
    organizationId: c.organizationId,
    invoiceId: c.invoice.id,
    level: i + 1,
    totalLevels: c.levels.length,
    approverRole: (l.role as Role | undefined) ?? null,
    approverUserId: l.userId ?? null,
    status: (i === 0 ? 'PENDING' : 'WAITING') as 'PENDING' | 'WAITING',
    ruleId: c.ruleId,
    ruleKey,
    runKey: c.runKey,
    requestedBy: c.requestedBy ?? null,
    comment: c.reasonNote ?? null,
  }));
  const res = await c.tx.approval.createMany({ data, skipDuplicates: true });
  if (res.count > 0) await notifyApprovers(c.tx, c.organizationId, c.invoice, data[0].approverRole, data[0].approverUserId, `${c.runKey}:${ruleKey}:1`);
  return { created: res.count };
}

export async function notifyApprovers(
  tx: Tx,
  organizationId: string,
  invoice: { id: string; invoiceNumber: string | null },
  role: Role | null,
  userId: string | null,
  keyPart: string,
) {
  const ids = userId ? [userId] : role ? await usersWithRole(organizationId, role, tx) : [];
  for (const id of ids) {
    await notifyUser(
      {
        organizationId,
        userId: id,
        type: 'APPROVAL_REQUESTED',
        title: 'Approval required',
        message: `Invoice ${invoice.invoiceNumber ?? invoice.id.slice(0, 8)} requires your approval.`,
        invoiceId: invoice.id,
        dedupeKey: `approval:${invoice.id}:${keyPart}`,
      },
      tx,
    );
  }
}
