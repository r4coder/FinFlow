import { randomUUID } from 'node:crypto';
import { InvoiceStatus, Prisma, RiskLevel } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { AuthContext } from '../middleware/auth';
import { storage, invoiceFileKey } from '../storage/storage.service';
import { sha256 } from '../security/crypto';
import { audit } from '../services/audit.service';
import { badRequest, conflict, notFound } from '../utils/errors';
import { pageMeta, paginationParams } from '../utils/http';
import { parseDate } from '../utils/money';
import { env } from '../config/env';
import { enqueueInvoiceProcessing } from '../jobs/queue';
import { runEvent } from '../rules/engine';
import { validateUpload, UploadedFile } from './file.validation';
import { presentInvoice, presentLineItem } from './invoice.presenter';

const normalizeVendor = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');

export async function uploadInvoice(a: AuthContext, file: UploadedFile | undefined) {
  const settings = await prisma.organizationSettings.findUnique({ where: { organizationId: a.organizationId } });
  const maxBytes = Math.min(env.MAX_UPLOAD_MB, settings?.maxUploadMb ?? env.MAX_UPLOAD_MB) * 1024 * 1024;
  const v = validateUpload(file, maxBytes);
  const f = file!;
  const id = randomUUID();
  const key = invoiceFileKey(a.organizationId, id, v.safeName);
  await storage.save(key, f.buffer);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.invoice.create({
        data: { id, organizationId: a.organizationId, status: 'UPLOADED', processingStatus: 'QUEUED', source: 'UPLOAD', fileUrl: key, fileName: v.displayName, mimeType: v.mime, fileHash: sha256(f.buffer), uploadedBy: a.userId, processingRun: 1 },
      });
      await audit({ organizationId: a.organizationId, action: 'invoice.uploaded', entityType: 'invoice', entityId: id, invoiceId: id, userId: a.userId, userName: a.fullName, metadata: { fileName: v.displayName, size: f.size, mimeType: v.mime } }, tx);
      await tx.onboarding.updateMany({ where: { organizationId: a.organizationId }, data: { firstInvoice: true } });
      await runEvent({ tx, organizationId: a.organizationId, invoiceId: id, triggers: ['INVOICE_UPLOADED'], runKey: 'upload' });
    });
  } catch (e) {
    await storage.remove(key).catch(() => undefined);
    throw e;
  }
  await enqueueInvoiceProcessing({ invoiceId: id, organizationId: a.organizationId, run: 1 });
  return prisma.invoice.findUniqueOrThrow({ where: { id }, include: { vendor: true } });
}

const LineSchema = z.object({
  description: z.string().min(1).max(300),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(100).nullish(),
  taxAmount: z.coerce.number().min(0).nullish(),
  lineTotal: z.coerce.number().min(0).nullish(),
});
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullish();
export const InvoiceFieldsSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100).nullish(),
  vendorName: z.string().trim().min(1).max(200).nullish(),
  vendorId: z.string().uuid().nullish(),
  invoiceDate: dateStr,
  dueDate: dateStr,
  currency: z.string().trim().length(3).toUpperCase().nullish(),
  subtotal: z.coerce.number().nullish(),
  tax: z.coerce.number().nullish(),
  total: z.coerce.number().nullish(),
  purchaseOrderNumber: z.string().trim().max(100).nullish(),
  paymentTerms: z.string().trim().max(100).nullish(),
  lineItems: z.array(LineSchema).max(200).optional(),
});
export type InvoiceFields = z.infer<typeof InvoiceFieldsSchema>;

async function resolveVendorId(tx: Prisma.TransactionClient, organizationId: string, f: InvoiceFields): Promise<string | null | undefined> {
  if (f.vendorId) {
    const v = await tx.vendor.findFirst({ where: { id: f.vendorId, organizationId } });
    if (!v) throw badRequest('Vendor not found in this organization', 'VENDOR_NOT_FOUND');
    return v.id;
  }
  if (f.vendorName) {
    const v = await tx.vendor.upsert({
      where: { organizationId_normalizedName: { organizationId, normalizedName: normalizeVendor(f.vendorName) } },
      create: { organizationId, name: f.vendorName, normalizedName: normalizeVendor(f.vendorName), verified: false },
      update: {},
    });
    return v.id;
  }
  return undefined;
}

export async function createManualInvoice(a: AuthContext, input: InvoiceFields) {
  const id = randomUUID();
  await prisma.$transaction(async (tx) => {
    const vendorId = await resolveVendorId(tx, a.organizationId, input);
    await tx.invoice.create({
      data: {
        id,
        organizationId: a.organizationId,
        status: 'UPLOADED',
        processingStatus: 'QUEUED',
        source: 'MANUAL',
        useStoredData: true,
        uploadedBy: a.userId,
        processingRun: 1,
        vendorId: vendorId ?? null,
        invoiceNumber: input.invoiceNumber ?? null,
        invoiceDate: parseDate(input.invoiceDate),
        dueDate: parseDate(input.dueDate),
        currency: input.currency ?? null,
        subtotal: input.subtotal ?? null,
        tax: input.tax ?? null,
        total: input.total ?? null,
        purchaseOrderNumber: input.purchaseOrderNumber ?? null,
        paymentTerms: input.paymentTerms ?? null,
        aiConfidence: 1,
        lineItems: { create: (input.lineItems ?? []).map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate ?? null, taxAmount: l.taxAmount ?? null, lineTotal: l.lineTotal ?? l.quantity * l.unitPrice })) },
      },
    });
    await audit({ organizationId: a.organizationId, action: 'invoice.created_manually', entityType: 'invoice', entityId: id, invoiceId: id, userId: a.userId, userName: a.fullName }, tx);
    await tx.onboarding.updateMany({ where: { organizationId: a.organizationId }, data: { firstInvoice: true } });
    await runEvent({ tx, organizationId: a.organizationId, invoiceId: id, triggers: ['INVOICE_UPLOADED'], runKey: 'upload' });
  });
  await enqueueInvoiceProcessing({ invoiceId: id, organizationId: a.organizationId, run: 1 });
  return prisma.invoice.findUniqueOrThrow({ where: { id }, include: { vendor: true } });
}

const EDITABLE: InvoiceStatus[] = ['MANUAL_REVIEW', 'FAILED', 'EXTRACTED', 'UPLOADED'];

export async function editInvoice(a: AuthContext, invoiceId: string, patch: InvoiceFields) {
  return prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: a.organizationId } });
    if (!inv) throw notFound('Invoice not found');
    if (!EDITABLE.includes(inv.status)) throw conflict(`Invoices in status ${inv.status} cannot be edited. Move it to the exception queue first.`, 'INVOICE_NOT_EDITABLE');
    const vendorId = await resolveVendorId(tx, a.organizationId, patch);
    const data: Prisma.InvoiceUncheckedUpdateInput = { useStoredData: true };
    const changed: string[] = [];
    const set = (k: keyof Prisma.InvoiceUncheckedUpdateInput, v: unknown, name = String(k)) => {
      if (v !== undefined) {
        (data as any)[k] = v;
        changed.push(name);
      }
    };
    set('invoiceNumber', patch.invoiceNumber);
    if (vendorId !== undefined) set('vendorId', vendorId, 'vendor');
    set('invoiceDate', patch.invoiceDate === undefined ? undefined : parseDate(patch.invoiceDate));
    set('dueDate', patch.dueDate === undefined ? undefined : parseDate(patch.dueDate));
    set('currency', patch.currency);
    set('subtotal', patch.subtotal);
    set('tax', patch.tax);
    set('total', patch.total);
    set('purchaseOrderNumber', patch.purchaseOrderNumber);
    set('paymentTerms', patch.paymentTerms);
    if (patch.lineItems) {
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
      await tx.invoiceLineItem.createMany({ data: patch.lineItems.map((l) => ({ invoiceId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate ?? null, taxAmount: l.taxAmount ?? null, lineTotal: l.lineTotal ?? l.quantity * l.unitPrice })) });
      changed.push('lineItems');
    }
    if (!changed.length) throw badRequest('Nothing to update', 'NO_CHANGES');
    const updated = await tx.invoice.update({ where: { id: invoiceId }, data, include: { vendor: true } });
    await audit({ organizationId: a.organizationId, action: 'invoice.edited', entityType: 'invoice', entityId: invoiceId, invoiceId, userId: a.userId, userName: a.fullName, metadata: { fields: changed } }, tx);
    return updated;
  });
}

const REPROCESSABLE: InvoiceStatus[] = ['MANUAL_REVIEW', 'FAILED', 'PENDING_APPROVAL', 'EXTRACTED', 'UPLOADED'];

export async function reprocessInvoice(a: AuthContext, invoiceId: string, reextract: boolean) {
  const run = await prisma.$transaction(async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId: a.organizationId } });
    if (!inv) throw notFound('Invoice not found');
    if (!REPROCESSABLE.includes(inv.status)) throw conflict(`Invoices in status ${inv.status} cannot be re-processed`, 'INVOICE_NOT_REPROCESSABLE');
    if (inv.lockedAt && Date.now() - inv.lockedAt.getTime() < 5 * 60_000) throw conflict('Invoice is currently being processed', 'ALREADY_PROCESSING');
    const useStored = !inv.fileUrl ? true : reextract ? false : inv.useStoredData;
    const next = inv.processingRun + 1;
    await tx.invoice.update({ where: { id: invoiceId }, data: { processingRun: next, processingStatus: 'QUEUED', status: 'UPLOADED', useStoredData: useStored, failureReason: null, retryCount: 0 } });
    await audit({ organizationId: a.organizationId, action: 'invoice.reprocess_requested', entityType: 'invoice', entityId: invoiceId, invoiceId, userId: a.userId, userName: a.fullName, metadata: { run: next, reextract: !useStored } }, tx);
    return next;
  });
  await enqueueInvoiceProcessing({ invoiceId, organizationId: a.organizationId, run });
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { vendor: true } });
}

export const ListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.nativeEnum(InvoiceStatus).optional(),
  risk: z.nativeEnum(RiskLevel).optional(),
  vendorId: z.string().uuid().optional(),
  currency: z.string().length(3).optional(),
  tag: z.string().max(50).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  minAmount: z.coerce.number().optional(),
  maxAmount: z.coerce.number().optional(),
  sortBy: z.enum(['createdAt', 'invoiceDate', 'total', 'invoiceNumber', 'status', 'riskLevel']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

function buildWhere(organizationId: string, q: z.infer<typeof ListQuerySchema>): Prisma.InvoiceWhereInput {
  const where: Prisma.InvoiceWhereInput = { organizationId };
  if (q.search) where.OR = [{ invoiceNumber: { contains: q.search, mode: 'insensitive' } }, { fileName: { contains: q.search, mode: 'insensitive' } }, { vendor: { name: { contains: q.search, mode: 'insensitive' } } }];
  if (q.status) where.status = q.status;
  if (q.risk) where.riskLevel = q.risk;
  if (q.vendorId) where.vendorId = q.vendorId;
  if (q.currency) where.currency = q.currency.toUpperCase();
  if (q.tag) where.tags = { some: { tag: { name: q.tag } } };
  if (q.dateFrom || q.dateTo) where.invoiceDate = { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) };
  if (q.minAmount !== undefined || q.maxAmount !== undefined) where.total = { ...(q.minAmount !== undefined ? { gte: q.minAmount } : {}), ...(q.maxAmount !== undefined ? { lte: q.maxAmount } : {}) };
  return where;
}

export async function listInvoices(organizationId: string, query: Record<string, unknown>) {
  const q = ListQuerySchema.parse(query);
  const { page, pageSize, skip, take } = paginationParams(query);
  const where = buildWhere(organizationId, q);
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({ where, include: { vendor: true, tags: { include: { tag: true } } }, orderBy: { [q.sortBy]: q.sortDir } as any, skip, take }),
  ]);
  return { items: rows.map(presentInvoice), meta: pageMeta(total, page, pageSize) };
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of invoice data only: no passwords, keys or secrets exist in this projection. */
export async function exportInvoicesCsv(organizationId: string, query: Record<string, unknown>) {
  const q = ListQuerySchema.parse(query);
  const rows = await prisma.invoice.findMany({ where: buildWhere(organizationId, q), include: { vendor: true, tags: { include: { tag: true } } }, orderBy: { [q.sortBy]: q.sortDir } as any, take: 10000 });
  const header = ['Invoice Number', 'Vendor', 'Invoice Date', 'Due Date', 'Currency', 'Subtotal', 'Tax', 'Total', 'PO Number', 'Status', 'Risk', 'AI Confidence %', 'Auto Approved', 'Duplicate', 'Tags', 'Created At'];
  const lines = rows.map((r) => {
    const p = presentInvoice(r);
    return [p.invoiceNumber, p.vendor?.name, p.invoiceDate, p.dueDate, p.currency, p.subtotal, p.tax, p.total, p.purchaseOrderNumber, p.status, p.riskLevel, p.aiConfidence === null ? '' : Math.round(p.aiConfidence * 100), p.autoApproved, p.duplicateDetected, (p.tags ?? []).join('|'), p.createdAt.toISOString()].map(csvCell).join(',');
  });
  return [header.join(','), ...lines].join('\n');
}

export async function getInvoiceDetail(organizationId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, organizationId },
    include: {
      vendor: true,
      lineItems: true,
      tags: { include: { tag: true } },
      approvals: { orderBy: [{ createdAt: 'asc' }, { level: 'asc' }] },
      tasks: { orderBy: { createdAt: 'asc' } },
      executions: { orderBy: { startedAt: 'desc' }, take: 100 },
      aiJobs: { orderBy: { startedAt: 'desc' }, take: 10 },
    },
  });
  if (!inv) throw notFound('Invoice not found');
  const timeline = await prisma.auditLog.findMany({ where: { organizationId, invoiceId: id }, orderBy: { createdAt: 'asc' }, take: 200 });
  const userIds = [...new Set([...inv.approvals.map((x) => x.decidedBy), inv.uploadedBy, inv.approvedBy, inv.rejectedBy].filter(Boolean) as string[])];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } });
  const names = Object.fromEntries(users.map((u) => [u.id, u.fullName]));
  const duplicateOf = inv.duplicateOfId ? await prisma.invoice.findFirst({ where: { id: inv.duplicateOfId, organizationId }, select: { id: true, invoiceNumber: true } }) : null;
  return {
    ...presentInvoice(inv),
    uploadedByName: inv.uploadedBy ? names[inv.uploadedBy] ?? null : null,
    approvedByName: inv.approvedBy ? names[inv.approvedBy] ?? null : null,
    rejectedByName: inv.rejectedBy ? names[inv.rejectedBy] ?? null : null,
    lineItems: inv.lineItems.map(presentLineItem),
    extraction: inv.extraction,
    validation: inv.validation,
    anomalies: inv.anomalies,
    aiAnalysis: inv.aiAnalysis,
    duplicateOf,
    approvals: inv.approvals.map((x) => ({ ...x, decidedByName: x.decidedBy ? names[x.decidedBy] ?? null : null })),
    tasks: inv.tasks,
    latestRunKey: `run-${inv.completedRun}:`,
    executions: inv.executions,
    aiJobs: inv.aiJobs,
    timeline,
  };
}

export async function getInvoiceFile(organizationId: string, id: string) {
  const inv = await prisma.invoice.findFirst({ where: { id, organizationId }, select: { fileUrl: true, mimeType: true, fileName: true } });
  if (!inv?.fileUrl) throw notFound('This invoice has no stored document');
  return { buffer: await storage.read(inv.fileUrl), mimeType: inv.mimeType ?? 'application/octet-stream', fileName: inv.fileName ?? 'invoice' };
}
