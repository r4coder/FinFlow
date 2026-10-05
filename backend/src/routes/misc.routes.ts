import { Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { auth, requirePermission } from '../middleware/auth';
import { asyncHandler, ok, pageMeta, paginationParams } from '../utils/http';
import { notFound } from '../utils/errors';
import * as vendors from '../services/vendor.service';
import * as users from '../services/user.service';
import * as aiSettings from '../services/ai-settings.service';
import * as analytics from '../analytics/analytics.service';

const idOf = (v: unknown) => z.string().uuid('Invalid id').parse(v);

export const vendorRouter = Router();
vendorRouter.get('/', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await vendors.listVendors(auth(req).organizationId, req.query))));
vendorRouter.post('/', requirePermission('vendor:write'), asyncHandler(async (req, res) => ok(res, await vendors.createVendor(auth(req), vendors.VendorSchema.parse(req.body)), 201)));
vendorRouter.get('/:id', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await vendors.getVendor(auth(req).organizationId, idOf(req.params.id)))));
vendorRouter.patch('/:id', requirePermission('vendor:write'), asyncHandler(async (req, res) => ok(res, await vendors.updateVendor(auth(req), idOf(req.params.id), vendors.VendorSchema.partial().parse(req.body)))));

export const userRouter = Router();
userRouter.get('/', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await users.listUsers(auth(req).organizationId))));
userRouter.post('/', requirePermission('users:manage'), asyncHandler(async (req, res) => ok(res, await users.createUser(auth(req), users.CreateUserSchema.parse(req.body)), 201)));
userRouter.patch('/:id/role', requirePermission('users:manage'), asyncHandler(async (req, res) => ok(res, await users.changeRole(auth(req), idOf(req.params.id), z.object({ role: z.nativeEnum(Role) }).parse(req.body).role))));
userRouter.delete('/:id', requirePermission('users:manage'), asyncHandler(async (req, res) => { await users.removeUser(auth(req), idOf(req.params.id)); ok(res, { removed: true }); }));

export const settingsRouter = Router();
settingsRouter.get('/ai', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await aiSettings.getAiSettings(auth(req).organizationId))));
settingsRouter.post('/ai/validate', requirePermission('settings:ai'), asyncHandler(async (req, res) => {
  const { apiKey } = z.object({ apiKey: z.string().trim().min(10).max(200) }).parse(req.body);
  ok(res, await aiSettings.validateKey(apiKey)); // returns only { valid, reason }, never echoes the key
}));
settingsRouter.put('/ai', requirePermission('settings:ai'), asyncHandler(async (req, res) => ok(res, await aiSettings.updateAiSettings(auth(req), aiSettings.UpdateAiSchema.parse(req.body)))));
settingsRouter.delete('/ai', requirePermission('settings:ai'), asyncHandler(async (req, res) => ok(res, await aiSettings.deleteAiKey(auth(req)))));

export const analyticsRouter = Router();
analyticsRouter.get('/dashboard', requirePermission('analytics:read'), asyncHandler(async (req, res) => ok(res, await analytics.dashboard(auth(req).organizationId))));
analyticsRouter.get('/automation', requirePermission('analytics:read'), asyncHandler(async (req, res) => ok(res, await analytics.automation(auth(req).organizationId))));

export const auditRouter = Router();
auditRouter.get('/', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const a = auth(req);
  const q = z.object({ action: z.string().max(80).optional(), entityType: z.string().max(40).optional(), invoiceId: z.string().uuid().optional(), userId: z.string().uuid().optional(), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  const { page, pageSize, skip, take } = paginationParams(req.query, { pageSize: 50, maxPageSize: 200 });
  const where: Prisma.AuditLogWhereInput = {
    organizationId: a.organizationId,
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.dateFrom || q.dateTo ? { createdAt: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo + 'T23:59:59Z') } : {}) } } : {}),
  };
  const [total, items] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take })]);
  ok(res, { items, meta: pageMeta(total, page, pageSize) });
}));

export const notificationRouter = Router();
notificationRouter.get('/', asyncHandler(async (req, res) => {
  const a = auth(req);
  const { page, pageSize, skip, take } = paginationParams(req.query, { pageSize: 30, maxPageSize: 100 });
  const where = { organizationId: a.organizationId, userId: a.userId, ...(req.query.unread === 'true' ? { read: false } : {}) };
  const [total, unread, items] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { organizationId: a.organizationId, userId: a.userId, read: false } }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
  ]);
  ok(res, { items, unread, meta: pageMeta(total, page, pageSize) });
}));
notificationRouter.post('/read-all', asyncHandler(async (req, res) => {
  const a = auth(req);
  await prisma.notification.updateMany({ where: { organizationId: a.organizationId, userId: a.userId, read: false }, data: { read: true } });
  ok(res, { updated: true });
}));
notificationRouter.post('/:id/read', asyncHandler(async (req, res) => {
  const a = auth(req);
  const r = await prisma.notification.updateMany({ where: { id: idOf(req.params.id), organizationId: a.organizationId, userId: a.userId }, data: { read: true } });
  if (!r.count) throw notFound('Notification not found');
  ok(res, { updated: true });
}));

export const taskRouter = Router();
taskRouter.get('/', requirePermission('invoice:read'), asyncHandler(async (req, res) => {
  const a = auth(req);
  const items = await prisma.task.findMany({ where: { organizationId: a.organizationId, ...(req.query.status === 'OPEN' ? { status: 'OPEN' } : {}) }, orderBy: { createdAt: 'desc' }, take: 100, include: { invoice: { select: { invoiceNumber: true } } } });
  ok(res, items);
}));
taskRouter.post('/:id/complete', requirePermission('invoice:write'), asyncHandler(async (req, res) => {
  const a = auth(req);
  const r = await prisma.task.updateMany({ where: { id: idOf(req.params.id), organizationId: a.organizationId }, data: { status: 'DONE' } });
  if (!r.count) throw notFound('Task not found');
  ok(res, { updated: true });
}));
