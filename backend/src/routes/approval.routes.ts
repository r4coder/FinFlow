import { Router } from 'express';
import { ApprovalStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { auth, requirePermission } from '../middleware/auth';
import { canDecide, decideApproval, resolveException } from '../approvals/approval.service';
import { asyncHandler, ok, pageMeta, paginationParams } from '../utils/http';
import { num } from '../utils/money';

export const approvalRouter = Router();
export const exceptionRouter = Router();
const idOf = (v: unknown) => z.string().uuid('Invalid id').parse(v);

approvalRouter.get(
  '/',
  requirePermission('invoice:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const status = z.nativeEnum(ApprovalStatus).optional().parse(req.query.status);
    const mine = req.query.mine === 'true';
    const { page, pageSize, skip, take } = paginationParams(req.query);
    const where = { organizationId: a.organizationId, ...(status ? { status } : {}), ...(mine ? { status: 'PENDING' as const } : {}) };
    let rows = await prisma.approval.findMany({ where, include: { invoice: { include: { vendor: true } } }, orderBy: { createdAt: 'desc' } });
    if (mine) rows = rows.filter((r) => canDecide(a, r));
    const total = rows.length;
    rows = rows.slice(skip, skip + take);
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy, r.approverUserId, r.invoice.uploadedBy]).filter(Boolean) as string[])];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoice.invoiceNumber,
        vendor: r.invoice.vendor?.name ?? null,
        amount: num(r.invoice.total),
        currency: r.invoice.currency,
        riskLevel: r.invoice.riskLevel,
        level: r.level,
        totalLevels: r.totalLevels,
        approverRole: r.approverRole,
        approver: r.approverUserId ? name.get(r.approverUserId) ?? 'Specific user' : r.approverRole,
        requestedBy: r.requestedBy ? name.get(r.requestedBy) ?? null : r.ruleId ? 'Automation rule' : 'System',
        uploadedBy: r.invoice.uploadedBy ? name.get(r.invoice.uploadedBy) ?? null : null,
        status: r.status,
        comment: r.comment,
        decidedBy: r.decidedBy ? name.get(r.decidedBy) ?? null : null,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
        canDecide: r.status === 'PENDING' && canDecide(a, r),
      })),
      meta: pageMeta(total, page, pageSize),
    });
  }),
);

const Comment = z.object({ comment: z.string().max(1000).optional() });
for (const [path, action] of [['approve', 'approve'], ['reject', 'reject'], ['request-changes', 'request_changes']] as const) {
  approvalRouter.post(
    `/:id/${path}`,
    requirePermission('invoice:approve'),
    asyncHandler(async (req, res) => ok(res, await decideApproval(auth(req), idOf(req.params.id), action, Comment.parse(req.body ?? {}).comment))),
  );
}

exceptionRouter.get(
  '/',
  requirePermission('invoice:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const { page, pageSize, skip, take } = paginationParams(req.query);
    const where = { organizationId: a.organizationId, status: { in: ['MANUAL_REVIEW', 'FAILED'] as ('MANUAL_REVIEW' | 'FAILED')[] } };
    const [total, rows] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({ where, include: { vendor: true }, orderBy: { updatedAt: 'desc' }, skip, take }),
    ]);
    ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        fileName: r.fileName,
        vendor: r.vendor?.name ?? null,
        total: num(r.total),
        currency: r.currency,
        status: r.status,
        riskLevel: r.riskLevel,
        aiConfidence: r.aiConfidence,
        duplicateDetected: r.duplicateDetected,
        reasons: r.exceptionReasons ?? [],
        failureReason: r.failureReason,
        updatedAt: r.updatedAt,
      })),
      meta: pageMeta(total, page, pageSize),
    });
  }),
);

exceptionRouter.post(
  '/:id/resolve',
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const body = z.object({ action: z.enum(['APPROVE', 'REJECT', 'SEND_FOR_APPROVAL']), note: z.string().max(1000).optional() }).parse(req.body);
    const needed = body.action === 'SEND_FOR_APPROVAL' ? 'invoice:write' : 'invoice:approve';
    const { can } = await import('../security/permissions');
    if (!can(a.role, needed)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' } });
    ok(res, await resolveException(a, idOf(req.params.id), body.action, body.note));
  }),
);
