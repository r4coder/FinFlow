import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env';
import { auth, requirePermission } from '../middleware/auth';
import * as svc from '../invoices/invoice.service';
import { presentInvoice } from '../invoices/invoice.presenter';
import { asyncHandler, ok } from '../utils/http';

export const invoiceRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
const idOf = (v: unknown) => z.string().uuid('Invalid id').parse(v);

invoiceRouter.get('/', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await svc.listInvoices(auth(req).organizationId, req.query))));

invoiceRouter.get(
  '/export.csv',
  requirePermission('invoice:read'),
  asyncHandler(async (req, res) => {
    const csv = await svc.exportInvoicesCsv(auth(req).organizationId, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(csv);
  }),
);

invoiceRouter.post(
  '/upload',
  requirePermission('invoice:write'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const inv = await svc.uploadInvoice(auth(req), req.file ? { originalname: req.file.originalname, mimetype: req.file.mimetype, buffer: req.file.buffer, size: req.file.size } : undefined);
    ok(res, presentInvoice(inv), 201);
  }),
);

invoiceRouter.post(
  '/manual',
  requirePermission('invoice:write'),
  asyncHandler(async (req, res) => ok(res, presentInvoice(await svc.createManualInvoice(auth(req), svc.InvoiceFieldsSchema.parse(req.body))), 201)),
);

invoiceRouter.get('/:id', requirePermission('invoice:read'), asyncHandler(async (req, res) => ok(res, await svc.getInvoiceDetail(auth(req).organizationId, idOf(req.params.id)))));

invoiceRouter.get(
  '/:id/file',
  requirePermission('invoice:read'),
  asyncHandler(async (req, res) => {
    const f = await svc.getInvoiceFile(auth(req).organizationId, idOf(req.params.id));
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.fileName)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.buffer);
  }),
);

invoiceRouter.patch(
  '/:id',
  requirePermission('invoice:write'),
  asyncHandler(async (req, res) => ok(res, presentInvoice(await svc.editInvoice(auth(req), idOf(req.params.id), svc.InvoiceFieldsSchema.parse(req.body))))),
);

invoiceRouter.post(
  '/:id/reprocess',
  requirePermission('invoice:write'),
  asyncHandler(async (req, res) => {
    const { reextract } = z.object({ reextract: z.boolean().default(false) }).parse(req.body ?? {});
    ok(res, presentInvoice(await svc.reprocessInvoice(auth(req), idOf(req.params.id), reextract)), 202);
  }),
);
