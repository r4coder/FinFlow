import { Role } from '@prisma/client';
import { prisma, Tx } from '../db';
import { AuthContext } from '../middleware/auth';
import { audit } from '../services/audit.service';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { notifyUser } from '../notifications/notification.service';
import { runEvent } from '../rules/engine';
import { satisfiesRole } from '../security/permissions';
import { notifyApprovers } from './chain';

export type DecisionAction = 'approve' | 'reject' | 'request_changes';

export function canDecide(a: AuthContext, approval: { approverRole: Role | null; approverUserId: string | null }) {
  if (approval.approverUserId) return a.userId === approval.approverUserId || a.role === 'OWNER';
  return satisfiesRole(a.role, approval.approverRole ?? 'FINANCE_MANAGER');
}

export async function decideApproval(a: AuthContext, approvalId: string, action: DecisionAction, comment?: string) {
  if (action === 'reject' && (!comment || comment.trim().length < 3)) throw badRequest('A reason is required to reject an invoice', 'REASON_REQUIRED');
  if (action === 'request_changes' && (!comment || comment.trim().length < 3)) throw badRequest('Please describe the changes that are needed', 'REASON_REQUIRED');

  return prisma.$transaction(async (tx) => {
    const approval = await tx.approval.findFirst({ where: { id: approvalId, organizationId: a.organizationId }, include: { invoice: true } });
    if (!approval) throw notFound('Approval not found');
    if (approval.status !== 'PENDING') throw conflict(`This approval is already ${approval.status.toLowerCase().replace('_', ' ')}`, 'APPROVAL_NOT_PENDING');
    if (!canDecide(a, approval)) throw forbidden('You are not an authorized approver for this request');

    const now = new Date();
    const status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
    // optimistic guard: only one request can move the approval out of PENDING (double-click / race safe)
    const claim = await tx.approval.updateMany({ where: { id: approvalId, status: 'PENDING' }, data: { status, decidedBy: a.userId, decidedAt: now, comment: comment ?? approval.comment } });
    if (claim.count === 0) throw conflict('This approval was just decided by someone else', 'APPROVAL_NOT_PENDING');

    const inv = approval.invoice;
    const label = inv.invoiceNumber ?? inv.id.slice(0, 8);
    const base = { organizationId: a.organizationId, userId: a.userId, userName: a.fullName, entityType: 'invoice', entityId: inv.id, invoiceId: inv.id };
    const runKey = `approval-${approvalId}`;
    const notifyUploader = async (type: string, title: string, message: string) => {
      if (inv.uploadedBy) await notifyUser({ organizationId: a.organizationId, userId: inv.uploadedBy, type, title, message, invoiceId: inv.id, dedupeKey: `${type}:${approvalId}` }, tx);
    };

    if (action === 'approve') {
      await audit({ ...base, action: 'approval.level_approved', metadata: { level: approval.level, of: approval.totalLevels, comment } }, tx);
      if (approval.level < approval.totalLevels) {
        const next = await tx.approval.findFirst({ where: { invoiceId: inv.id, ruleKey: approval.ruleKey, runKey: approval.runKey, level: approval.level + 1, status: 'WAITING' } });
        if (next) {
          await tx.approval.update({ where: { id: next.id }, data: { status: 'PENDING' } });
          await notifyApprovers(tx, a.organizationId, inv, next.approverRole, next.approverUserId, `${approval.runKey}:${approval.ruleKey}:${next.level}`);
        }
        return { invoiceStatus: 'PENDING_APPROVAL', nextLevel: approval.level + 1 };
      }
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'APPROVED', approvedBy: a.userId, approvedAt: now, exceptionReasons: [] } });
      await audit({ ...base, action: 'invoice.approved', metadata: { comment } }, tx);
      await notifyUploader('INVOICE_APPROVED', 'Invoice approved', `Invoice ${label} was approved by ${a.fullName}.`);
      await runEvent({ tx, organizationId: a.organizationId, invoiceId: inv.id, triggers: ['APPROVAL_COMPLETED'], runKey, depth: 1, actorUserId: a.userId });
      await runEvent({ tx, organizationId: a.organizationId, invoiceId: inv.id, triggers: ['INVOICE_APPROVED'], runKey, depth: 1, actorUserId: a.userId });
      return { invoiceStatus: 'APPROVED' };
    }

    await closeOpenApprovals(tx, inv.id, approvalId);
    if (action === 'reject') {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'REJECTED', rejectedBy: a.userId, rejectedAt: now, rejectionReason: comment } });
      await audit({ ...base, action: 'invoice.rejected', metadata: { reason: comment } }, tx);
      await notifyUploader('INVOICE_REJECTED', 'Invoice rejected', `Invoice ${label} was rejected by ${a.fullName}: ${comment}`);
      await runEvent({ tx, organizationId: a.organizationId, invoiceId: inv.id, triggers: ['APPROVAL_COMPLETED'], runKey, depth: 1, actorUserId: a.userId });
      await runEvent({ tx, organizationId: a.organizationId, invoiceId: inv.id, triggers: ['INVOICE_REJECTED'], runKey, depth: 1, actorUserId: a.userId });
      return { invoiceStatus: 'REJECTED' };
    }
    await tx.invoice.update({ where: { id: inv.id }, data: { status: 'MANUAL_REVIEW', exceptionReasons: [`Changes requested by ${a.fullName}: ${comment}`] } });
    await audit({ ...base, action: 'approval.changes_requested', metadata: { comment } }, tx);
    await notifyUploader('CHANGES_REQUESTED', 'Changes requested', `Changes requested on invoice ${label}: ${comment}`);
    return { invoiceStatus: 'MANUAL_REVIEW' };
  });
}

async function closeOpenApprovals(tx: Tx, invoiceId: string, exceptId: string) {
  await tx.approval.updateMany({ where: { invoiceId, id: { not: exceptId }, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'CANCELLED' } });
}

/** Resolve an item in the exception queue. */
export async function resolveException(a: AuthContext, invoiceId: string, action: 'APPROVE' | 'REJECT' | 'SEND_FOR_APPROVAL', note?: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: a.organizationId } });
    if (!inv) throw notFound('Invoice not found');
    if (!['MANUAL_REVIEW', 'FAILED'].includes(inv.status)) throw conflict('This invoice is not in the exception queue', 'NOT_IN_EXCEPTION_QUEUE');
    const label = inv.invoiceNumber ?? inv.id.slice(0, 8);
    const base = { organizationId: a.organizationId, userId: a.userId, userName: a.fullName, entityType: 'invoice', entityId: inv.id, invoiceId: inv.id };
    const now = new Date();
    if (action === 'APPROVE') {
      if (inv.status === 'FAILED') throw badRequest('A failed invoice has no extracted data; edit it or retry AI first', 'INVALID_RESOLUTION');
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'APPROVED', approvedBy: a.userId, approvedAt: now, exceptionReasons: [] } });
      await audit({ ...base, action: 'exception.resolved', metadata: { resolution: 'APPROVE', note } }, tx);
      await audit({ ...base, action: 'invoice.approved', metadata: { via: 'exception queue', note } }, tx);
      await runEvent({ tx, organizationId: a.organizationId, invoiceId, triggers: ['INVOICE_APPROVED'], runKey: `resolve-${now.getTime()}`, depth: 1, actorUserId: a.userId });
      return { invoiceStatus: 'APPROVED' };
    }
    if (action === 'REJECT') {
      if (!note || note.trim().length < 3) throw badRequest('A reason is required to reject an invoice', 'REASON_REQUIRED');
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'REJECTED', rejectedBy: a.userId, rejectedAt: now, rejectionReason: note, exceptionReasons: [] } });
      await audit({ ...base, action: 'exception.resolved', metadata: { resolution: 'REJECT', note } }, tx);
      await audit({ ...base, action: 'invoice.rejected', metadata: { reason: note, via: 'exception queue' } }, tx);
      await runEvent({ tx, organizationId: a.organizationId, invoiceId, triggers: ['INVOICE_REJECTED'], runKey: `resolve-${now.getTime()}`, depth: 1, actorUserId: a.userId });
      return { invoiceStatus: 'REJECTED' };
    }
    if (inv.status === 'FAILED') throw badRequest('A failed invoice has no extracted data; edit it or retry AI first', 'INVALID_RESOLUTION');
    await tx.invoice.update({ where: { id: inv.id }, data: { status: 'PENDING_APPROVAL', exceptionReasons: [] } });
    await tx.approval.create({
      data: { organizationId: a.organizationId, invoiceId, level: 1, totalLevels: 1, approverRole: 'FINANCE_MANAGER', status: 'PENDING', ruleKey: 'exception', runKey: `resolve-${now.getTime()}`, requestedBy: a.userId, comment: note ?? 'Sent for approval from exception queue' },
    });
    await notifyApprovers(tx, a.organizationId, inv, 'FINANCE_MANAGER', null, `resolve-${now.getTime()}`);
    await audit({ ...base, action: 'exception.resolved', metadata: { resolution: 'SEND_FOR_APPROVAL', note } }, tx);
    await audit({ ...base, action: 'approval.requested', metadata: { label, via: 'exception queue' } }, tx);
    return { invoiceStatus: 'PENDING_APPROVAL' };
  });
}
