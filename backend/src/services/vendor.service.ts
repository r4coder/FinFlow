import { z } from 'zod';
import { prisma } from '../db';
import { notFound, conflict } from '../utils/errors';
import { pageMeta, paginationParams } from '../utils/http';
import { num } from '../utils/money';
import { audit } from './audit.service';
import { AuthContext } from '../middleware/auth';

export const VendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).nullish().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(40).nullish(),
  address: z.string().trim().max(500).nullish(),
  taxId: z.string().trim().max(50).nullish(),
  paymentTerms: z.string().trim().max(100).nullish(),
  industry: z.string().trim().max(80).nullish(),
  group: z.string().trim().max(80).nullish(),
  verified: z.boolean().optional(),
});

const normalize = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');

export async function listVendors(organizationId: string, query: Record<string, unknown>) {
  const { page, pageSize, skip, take } = paginationParams(query, { pageSize: 25, maxPageSize: 200 });
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const where = { organizationId, ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) };
  const [total, rows] = await Promise.all([prisma.vendor.count({ where }), prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, skip, take })]);
  const stats = await prisma.invoice.groupBy({ by: ['vendorId'], where: { organizationId, vendorId: { in: rows.map((r) => r.id) } }, _count: { _all: true }, _sum: { total: true } });
  const byId = new Map(stats.map((s) => [s.vendorId, s]));
  return {
    items: rows.map((v) => ({ ...v, invoiceCount: byId.get(v.id)?._count._all ?? 0, totalSpend: num(byId.get(v.id)?._sum.total) ?? 0 })),
    meta: pageMeta(total, page, pageSize),
  };
}

export async function createVendor(a: AuthContext, input: z.infer<typeof VendorSchema>) {
  const exists = await prisma.vendor.findUnique({ where: { organizationId_normalizedName: { organizationId: a.organizationId, normalizedName: normalize(input.name) } } });
  if (exists) throw conflict('A vendor with this name already exists', 'VENDOR_EXISTS');
  const v = await prisma.vendor.create({ data: { ...input, organizationId: a.organizationId, normalizedName: normalize(input.name), verified: input.verified ?? true } });
  await audit({ organizationId: a.organizationId, action: 'vendor.created', entityType: 'vendor', entityId: v.id, userId: a.userId, userName: a.fullName, metadata: { name: v.name } });
  return v;
}

export async function getVendor(organizationId: string, id: string) {
  const v = await prisma.vendor.findFirst({ where: { id, organizationId } });
  if (!v) throw notFound('Vendor not found');
  const [agg, recent] = await Promise.all([
    prisma.invoice.aggregate({ where: { organizationId, vendorId: id }, _count: { _all: true }, _sum: { total: true } }),
    prisma.invoice.findMany({ where: { organizationId, vendorId: id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, invoiceNumber: true, total: true, currency: true, status: true, invoiceDate: true } }),
  ]);
  return { ...v, invoiceCount: agg._count._all, totalSpend: num(agg._sum.total) ?? 0, recentInvoices: recent.map((r) => ({ ...r, total: num(r.total) })) };
}

export async function updateVendor(a: AuthContext, id: string, input: Partial<z.infer<typeof VendorSchema>>) {
  const v = await prisma.vendor.findFirst({ where: { id, organizationId: a.organizationId } });
  if (!v) throw notFound('Vendor not found');
  const updated = await prisma.vendor.update({ where: { id }, data: { ...input, ...(input.name ? { normalizedName: normalize(input.name) } : {}) } });
  await audit({ organizationId: a.organizationId, action: 'vendor.updated', entityType: 'vendor', entityId: id, userId: a.userId, userName: a.fullName, metadata: { fields: Object.keys(input) } });
  return updated;
}
