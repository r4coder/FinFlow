import { Tx } from '../db';
import { audit } from '../services/audit.service';
import { createApprovalChain } from '../approvals/chain';
import { notifyUser, usersWithRole } from '../notifications/notification.service';
import type { Disposition } from '../rules/resolve';

export interface DecisionTarget {
  id: string;
  invoiceNumber: string | null;
  uploadedBy: string | null;
}

export interface DecisionOutcome {
  status: 'APPROVED' | 'PENDING_APPROVAL' | 'MANUAL_REVIEW' | 'REJECTED';
  events: ('APPROVAL_REQUESTED' | 'INVOICE_APPROVED' | 'INVOICE_REJECTED')[];
  note: string;
}

/**
 * Applies the winning disposition to the invoice. This is the ONLY place the engine changes an invoice's lifecycle
 * status as a result of a business decision. Runs inside the pipeline transaction; every write is idempotent.
 */
export async function applyDisposition(args: {
  tx: Tx;
  organizationId: string;
  invoice: DecisionTarget;
  disposition: Disposition;
  ruleId: string | null;
  ruleName: string;
  runKey: string;
  exceptionReasons: string[];
}): Promise<DecisionOutcome> {
  const { tx, organizationId, invoice, disposition, ruleId, ruleName, runKey } = args;
  const label = invoice.invoiceNumber ?? invoice.id.slice(0, 8);
  const now = new Date();

  switch (disposition.kind) {
    case 'AUTO_APPROVE': {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'APPROVED', autoApproved: true, approvedAt: now, approvedBy: null, exceptionReasons: [] },
      });
      await audit({ organizationId, action: 'invoice.auto_approved', entityType: 'invoice', entityId: invoice.id, invoiceId: invoice.id, metadata: { rule: ruleName } }, tx);
      if (invoice.uploadedBy) {
        await notifyUser(
          { organizationId, userId: invoice.uploadedBy, type: 'INVOICE_APPROVED', title: 'Invoice approved automatically', message: `Invoice ${label} was approved automatically by "${ruleName}".`, invoiceId: invoice.id, dedupeKey: `auto-approved:${invoice.id}:${runKey}` },
          tx,
        );
      }
      return { status: 'APPROVED', events: ['INVOICE_APPROVED'], note: `Auto-approved by "${ruleName}"` };
    }
    case 'REQUIRE_APPROVAL': {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'PENDING_APPROVAL', autoApproved: false, exceptionReasons: [] } });
      const { created } = await createApprovalChain({
        tx,
        organizationId,
        invoice,
        levels: disposition.levels ?? [{ role: 'FINANCE_MANAGER' }],
        ruleId,
        runKey,
        reasonNote: ruleId ? `Required by rule "${ruleName}"` : ruleName,
      });
      if (created > 0) {
        await audit(
          { organizationId, action: 'approval.requested', entityType: 'invoice', entityId: invoice.id, invoiceId: invoice.id, metadata: { rule: ruleName, levels: disposition.levels?.length ?? 1 } },
          tx,
        );
      }
      return { status: 'PENDING_APPROVAL', events: created > 0 ? ['APPROVAL_REQUESTED'] : [], note: `Approval required (${disposition.levels?.length ?? 1} level(s)) by "${ruleName}"` };
    }
    case 'MANUAL_REVIEW': {
      const reasons = [...args.exceptionReasons];
      if (disposition.reason) reasons.push(disposition.reason);
      if (!reasons.length) reasons.push(`Sent to manual review by "${ruleName}"`);
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'MANUAL_REVIEW', autoApproved: false, exceptionReasons: [...new Set(reasons)] } });
      await audit({ organizationId, action: 'invoice.manual_review', entityType: 'invoice', entityId: invoice.id, invoiceId: invoice.id, metadata: { rule: ruleName, reasons } }, tx);
      for (const userId of await usersWithRole(organizationId, 'FINANCE_MANAGER', tx)) {
        await notifyUser(
          { organizationId, userId, type: 'EXCEPTION', title: 'Invoice needs manual review', message: `Invoice ${label} was moved to the exception queue: ${[...new Set(reasons)].join('; ')}`, invoiceId: invoice.id, dedupeKey: `exception:${invoice.id}:${runKey}` },
          tx,
        );
      }
      return { status: 'MANUAL_REVIEW', events: [], note: `Moved to manual review (${ruleName})` };
    }
    case 'REJECT': {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: 'REJECTED', autoApproved: false, rejectedAt: now, rejectedBy: null, rejectionReason: disposition.reason ?? `Rejected by rule "${ruleName}"` },
      });
      await audit({ organizationId, action: 'invoice.auto_rejected', entityType: 'invoice', entityId: invoice.id, invoiceId: invoice.id, metadata: { rule: ruleName, reason: disposition.reason } }, tx);
      if (invoice.uploadedBy) {
        await notifyUser(
          { organizationId, userId: invoice.uploadedBy, type: 'INVOICE_REJECTED', title: 'Invoice rejected', message: `Invoice ${label} was rejected by "${ruleName}".`, invoiceId: invoice.id, dedupeKey: `auto-rejected:${invoice.id}:${runKey}` },
          tx,
        );
      }
      return { status: 'REJECTED', events: ['INVOICE_REJECTED'], note: `Rejected by "${ruleName}"` };
    }
  }
}
