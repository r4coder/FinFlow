import { Router } from 'express';
import { ExecutionResult, RuleTrigger } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { auth, requirePermission } from '../middleware/auth';
import { asyncHandler, ok, pageMeta, paginationParams } from '../utils/http';
import { badRequest, notFound } from '../utils/errors';
import * as rules from '../rules/rule.service';
import { RULE_TEMPLATES } from '../rules/templates';
import { describeCondition } from '../rules/conditions';
import { describeAction } from '../rules/actions';
import { Prisma } from '@prisma/client';

export const automationRouter = Router();
const idOf = (v: unknown) => z.string().uuid('Invalid id').parse(v);
const actor = (req: any) => ({ userId: auth(req).userId, fullName: auth(req).fullName });

automationRouter.get('/metadata', requirePermission('rule:read'), (_req, res) => ok(res, rules.builderMetadata()));

automationRouter.get(
  '/templates',
  requirePermission('rule:read'),
  asyncHandler(async (_req, res) =>
    ok(
      res,
      RULE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, trigger: t.trigger, priority: t.priority, conditions: t.conditions, actions: t.actions, conditionsSummary: describeCondition(t.conditions), actionsSummary: t.actions.map(describeAction) })),
    ),
  ),
);

automationRouter.get(
  '/rules',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const q = z
      .object({ search: z.string().max(100).optional(), trigger: z.nativeEnum(RuleTrigger).optional(), enabled: z.enum(['true', 'false']).optional(), createdBy: z.string().uuid().optional(), sortBy: z.enum(['priority', 'name', 'createdAt', 'updatedAt']).default('priority'), sortDir: z.enum(['asc', 'desc']).default('asc') })
      .parse(req.query);
    const { page, pageSize, skip, take } = paginationParams(req.query, { pageSize: 50, maxPageSize: 200 });
    const where: Prisma.BusinessRuleWhereInput = {
      organizationId: a.organizationId,
      deletedAt: null,
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
      ...(q.trigger ? { trigger: q.trigger } : {}),
      ...(q.enabled ? { enabled: q.enabled === 'true' } : {}),
      ...(q.createdBy ? { createdBy: q.createdBy } : {}),
    };
    const [total, items] = await Promise.all([prisma.businessRule.count({ where }), prisma.businessRule.findMany({ where, orderBy: { [q.sortBy]: q.sortDir } as any, skip, take })]);
    const stats = await prisma.businessRuleExecution.groupBy({ by: ['ruleId'], where: { organizationId: a.organizationId, matched: true, ruleId: { in: items.map((i) => i.id) } }, _count: { _all: true }, _max: { startedAt: true } });
    const byId = new Map(stats.map((s) => [s.ruleId, s]));
    const creators = await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.createdBy).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
    const cName = new Map(creators.map((c) => [c.id, c.fullName]));
    await prisma.onboarding.updateMany({ where: { organizationId: a.organizationId }, data: { rulesReviewed: true } });
    ok(res, { items: items.map((r) => ({ ...rules.presentRule(r, { executions: byId.get(r.id)?._count._all ?? 0, lastExecutionAt: byId.get(r.id)?._max.startedAt ?? null }), createdByName: r.createdBy ? cName.get(r.createdBy) ?? null : null })), meta: pageMeta(total, page, pageSize) });
  }),
);

automationRouter.post(
  '/rules',
  requirePermission('rule:write'),
  asyncHandler(async (req, res) => ok(res, rules.presentRule(await rules.createRule(auth(req).organizationId, actor(req), rules.RuleInputSchema.parse(req.body))), 201)),
);

// Dry-run of an UNSAVED draft (used by the rule builder before saving). Registered before /rules/:id routes.
automationRouter.post(
  '/rules/test-draft',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const body = rules.RuleInputSchema.extend({ invoiceId: z.string().uuid() }).parse(req.body);
    ok(res, await rules.dryRun(auth(req).organizationId, body.invoiceId, { name: body.name, priority: body.priority, trigger: body.trigger, conditions: body.conditions, actions: body.actions }));
  }),
);

automationRouter.get(
  '/rules/:id',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const r = await prisma.businessRule.findFirst({ where: { id: idOf(req.params.id), organizationId: auth(req).organizationId, deletedAt: null } });
    if (!r) throw notFound('Rule not found');
    ok(res, rules.presentRule(r));
  }),
);

automationRouter.patch(
  '/rules/:id',
  requirePermission('rule:write'),
  asyncHandler(async (req, res) => {
    const patch = rules.RuleInputSchema.partial().parse(req.body);
    ok(res, rules.presentRule(await rules.updateRule(auth(req).organizationId, idOf(req.params.id), actor(req), patch)));
  }),
);

automationRouter.delete(
  '/rules/:id',
  requirePermission('rule:write'),
  asyncHandler(async (req, res) => {
    await rules.deleteRule(auth(req).organizationId, idOf(req.params.id), actor(req));
    ok(res, { deleted: true });
  }),
);

automationRouter.post(
  '/rules/:id/duplicate',
  requirePermission('rule:write'),
  asyncHandler(async (req, res) => ok(res, rules.presentRule(await rules.duplicateRule(auth(req).organizationId, idOf(req.params.id), actor(req))), 201)),
);

automationRouter.get(
  '/rules/:id/versions',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const id = idOf(req.params.id);
    const exists = await prisma.businessRule.findFirst({ where: { id, organizationId: a.organizationId }, select: { id: true } });
    if (!exists) throw notFound('Rule not found');
    ok(res, await prisma.businessRuleVersion.findMany({ where: { ruleId: id, organizationId: a.organizationId }, orderBy: { version: 'desc' } }));
  }),
);

// Dry run: evaluates only; NEVER executes actions.
automationRouter.post(
  '/rules/:id/test',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const { invoiceId } = z.object({ invoiceId: z.string().uuid() }).parse(req.body);
    const r = await prisma.businessRule.findFirst({ where: { id: idOf(req.params.id), organizationId: a.organizationId, deletedAt: null } });
    if (!r) throw notFound('Rule not found');
    ok(res, await rules.dryRun(a.organizationId, invoiceId, { id: r.id, name: r.name, priority: r.priority, trigger: r.trigger, conditions: r.conditions, actions: r.actions }));
  }),
);

automationRouter.get(
  '/executions',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const q = z
      .object({
        ruleId: z.string().uuid().optional(),
        invoiceId: z.string().uuid().optional(),
        result: z.nativeEnum(ExecutionResult).optional(),
        matched: z.enum(['true', 'false']).optional(),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        sortDir: z.enum(['asc', 'desc']).default('desc'),
      })
      .parse(req.query);
    const { page, pageSize, skip, take } = paginationParams(req.query);
    const where: Prisma.BusinessRuleExecutionWhereInput = {
      organizationId: a.organizationId,
      ...(q.ruleId ? { ruleId: q.ruleId } : {}),
      ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.matched ? { matched: q.matched === 'true' } : {}),
      ...(q.dateFrom || q.dateTo ? { startedAt: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo + 'T23:59:59Z') } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([prisma.businessRuleExecution.count({ where }), prisma.businessRuleExecution.findMany({ where, orderBy: { startedAt: q.sortDir }, skip, take })]);
    const invs = await prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) }, organizationId: a.organizationId }, select: { id: true, invoiceNumber: true } });
    const inv = new Map(invs.map((i) => [i.id, i.invoiceNumber]));
    ok(res, { items: rows.map((r) => ({ ...r, invoiceNumber: inv.get(r.invoiceId) ?? null })), meta: pageMeta(total, page, pageSize) });
  }),
);

automationRouter.get(
  '/executions/:id',
  requirePermission('rule:read'),
  asyncHandler(async (req, res) => {
    const a = auth(req);
    const e = await prisma.businessRuleExecution.findFirst({ where: { id: idOf(req.params.id), organizationId: a.organizationId } });
    if (!e) throw notFound('Execution not found');
    const invoice = await prisma.invoice.findFirst({ where: { id: e.invoiceId, organizationId: a.organizationId }, select: { id: true, invoiceNumber: true, total: true, currency: true, status: true } });
    ok(res, { ...e, invoice: invoice ? { ...invoice, total: invoice.total ? Number(invoice.total) : null } : null });
  }),
);

export const _unused = badRequest;
