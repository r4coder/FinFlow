import { Prisma, RuleTrigger } from '@prisma/client';
import { prisma } from '../db';
import { AIProvider, AIProviderError, ExtractedInvoice, ExtractedInvoiceSchema } from '../ai/types';
import { getProviderForOrg } from '../ai/provider.factory';
import { storage } from '../storage/storage.service';
import { audit } from '../services/audit.service';
import { notifyUser, usersWithRole } from '../notifications/notification.service';
import { detectAnomalies, Finding, scoreRisk, validateExtraction } from '../validation/invoice.validation';
import { detectDuplicate } from './duplicate';
import { runEvent } from '../rules/engine';
import { num, parseDate, round2 } from '../utils/money';

const LOCK_TTL_MS = 5 * 60 * 1000;

export type PipelineResult = { skipped: true; reason: string } | { skipped: false; status: string; decidedBy: string | null };

const normalizeVendor = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');

/** Rebuilds an extraction object from stored (human-edited / manually entered) invoice data. */
async function extractionFromStored(invoiceId: string): Promise<ExtractedInvoice> {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { vendor: true, lineItems: true } });
  return ExtractedInvoiceSchema.parse({
    invoiceNumber: inv.invoiceNumber,
    vendorName: inv.vendor?.name ?? null,
    vendorTaxId: inv.vendor?.taxId ?? null,
    invoiceDate: inv.invoiceDate?.toISOString().slice(0, 10) ?? null,
    dueDate: inv.dueDate?.toISOString().slice(0, 10) ?? null,
    currency: inv.currency,
    subtotal: num(inv.subtotal),
    tax: num(inv.tax),
    total: num(inv.total),
    purchaseOrderNumber: inv.purchaseOrderNumber,
    paymentTerms: inv.paymentTerms,
    lineItems: inv.lineItems.map((l) => ({ description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice), taxRate: num(l.taxRate), taxAmount: num(l.taxAmount), lineTotal: num(l.lineTotal) })),
    confidence: inv.aiConfidence ?? 1, // human-entered/edited data is treated as fully confident
  });
}

/** Totals are computed by code, never by AI. Only fills gaps that can be derived with certainty. */
function deriveTotals(e: ExtractedInvoice): { data: ExtractedInvoice; derived: string[] } {
  const derived: string[] = [];
  const lineItems = e.lineItems.map((l) => {
    if (l.lineTotal === null) {
      derived.push('lineItem.lineTotal');
      return { ...l, lineTotal: round2(l.quantity * l.unitPrice) };
    }
    return l;
  });
  let subtotal = e.subtotal;
  if (subtotal === null && lineItems.length) {
    subtotal = round2(lineItems.reduce((a, l) => a + (l.lineTotal ?? 0), 0));
    derived.push('subtotal');
  }
  return { data: { ...e, lineItems, subtotal }, derived };
}

export async function processInvoice(invoiceId: string, run: number): Promise<PipelineResult> {
  // ---- 1. claim (lock + idempotency) -------------------------------------------------------------------------------
  const claimed = await prisma.invoice.updateMany({
    where: { id: invoiceId, completedRun: { lt: run }, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LOCK_TTL_MS) } }] },
    data: { lockedAt: new Date(), processingStatus: 'RUNNING', status: 'PROCESSING' },
  });
  if (claimed.count === 0) return { skipped: true, reason: 'already processed or locked by another worker' };

  const started = Date.now();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const organizationId = inv.organizationId;
  let provider: AIProvider | null = null;
  const attemptNo = (await prisma.aIProcessingJob.count({ where: { invoiceId, runNumber: run } })) + 1;
  const aiJob = await prisma.aIProcessingJob.create({ data: { organizationId, invoiceId, runNumber: run, attempt: attemptNo, status: 'RUNNING', provider: inv.useStoredData ? 'stored-data' : 'pending' } });

  try {
    const settings = await prisma.organizationSettings.findUnique({ where: { organizationId } });
    const tolerance = Number(settings?.roundingTolerance ?? 0.05);

    // ---- 2. extraction ---------------------------------------------------------------------------------------------
    let raw: ExtractedInvoice;
    if (inv.useStoredData) {
      raw = await extractionFromStored(invoiceId);
    } else {
      if (!inv.fileUrl || !inv.mimeType) throw new AIProviderError('Invoice has no stored file to extract', false);
      provider = await getProviderForOrg(organizationId);
      const buffer = await storage.read(inv.fileUrl);
      raw = await provider.extractInvoice({ buffer, mimeType: inv.mimeType, fileName: inv.fileName ?? 'invoice' });
    }
    await prisma.aIProcessingJob.update({
      where: { id: aiJob.id },
      data: { provider: provider?.name ?? 'stored-data', model: provider?.model ?? null, status: 'EXTRACTED', durationMs: Date.now() - started },
    });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'EXTRACTED' } });
    await audit({ organizationId, action: 'invoice.extracted', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { provider: provider?.name ?? 'stored-data', confidence: raw.confidence, run } });

    // ---- 3. deterministic totals + validation ------------------------------------------------------------------
    const { data: e, derived } = deriveTotals(raw);
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'VALIDATING' } });
    const validation = validateExtraction(e, tolerance);

    // ---- 4. vendor, duplicates, history (read-only phase) ----------------------------------------------------------
    const vendorName = e.vendorName?.trim() || null;
    let vendor =
      vendorName
        ? (e.vendorTaxId ? await prisma.vendor.findFirst({ where: { organizationId, taxId: e.vendorTaxId } }) : null) ??
          (await prisma.vendor.findUnique({ where: { organizationId_normalizedName: { organizationId, normalizedName: normalizeVendor(vendorName) } } }))
        : null;
    const invoiceDate = parseDate(e.invoiceDate);
    const dup = await detectDuplicate(prisma, {
      organizationId,
      invoiceId,
      createdAt: inv.createdAt,
      vendorId: vendor?.id ?? null,
      invoiceNumber: e.invoiceNumber,
      invoiceDate,
      total: e.total,
      fileHash: inv.fileHash,
    });
    let history = { count: 0, average: null as number | null };
    if (vendor) {
      const agg = await prisma.invoice.aggregate({
        where: { organizationId, vendorId: vendor.id, id: { not: invoiceId }, status: { notIn: ['FAILED', 'REJECTED'] }, total: { not: null } },
        _count: { _all: true },
        _avg: { total: true },
      });
      history = { count: agg._count._all, average: num(agg._avg.total) };
    }
    const anomalies = detectAnomalies({ extraction: e, unknownVendor: !vendor || !vendor.verified, duplicate: dup.duplicate, vendorHistory: history, highAmountMultiplier: settings?.highAmountMultiplier ?? 3 });
    const findings: Finding[] = [...validation, ...anomalies];
    const { score, level } = scoreRisk(findings);

    // ---- 5. AI explanation (explanation only: it can NEVER change risk or decisions) --------------------------------
    let analysis = { explanation: findings.length ? `Risk ${level}: ${findings.map((f) => f.message).join('; ')}` : `No issues found. Risk ${level}.`, aiScore: Math.min(100, score), source: 'deterministic' as string };
    if (provider) {
      try {
        const a = await provider.analyzeInvoice({ extraction: e, findings, riskLevel: level });
        analysis = { ...a, source: provider.name };
      } catch {
        /* explanation is optional; deterministic text is used */
      }
    }

    // ---- 6. single atomic transaction: persist + rules + decision + automation + notifications + audit --------------
    const blocking = findings.filter((f) => f.blocking).map((f) => f.message);
    const exceptionReasons = findings.filter((f) => f.severity !== 'low').map((f) => f.message);
    const triggers: RuleTrigger[] = ['INVOICE_PROCESSED'];
    if (dup.duplicate) triggers.push('DUPLICATE_DETECTED');
    if (anomalies.length) triggers.push('ANOMALY_DETECTED');
    if (validation.some((f) => f.severity === 'high' || f.blocking)) triggers.push('INVOICE_VALIDATION_FAILED');

    const outcome = await prisma.$transaction(
      async (tx) => {
        if (!vendor && vendorName) {
          vendor = await tx.vendor.upsert({
            where: { organizationId_normalizedName: { organizationId, normalizedName: normalizeVendor(vendorName) } },
            create: { organizationId, name: vendorName, normalizedName: normalizeVendor(vendorName), taxId: e.vendorTaxId, paymentTerms: e.paymentTerms, verified: false },
            update: {},
          });
        }
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
        if (e.lineItems.length) {
          await tx.invoiceLineItem.createMany({
            data: e.lineItems.map((l) => ({ invoiceId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, taxAmount: l.taxAmount, lineTotal: l.lineTotal ?? round2(l.quantity * l.unitPrice) })),
          });
        }
        // New run supersedes any approvals still open from earlier runs.
        await tx.approval.updateMany({ where: { invoiceId, status: { in: ['PENDING', 'WAITING'] } }, data: { status: 'CANCELLED', comment: 'Superseded by re-processing' } });

        await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            invoiceNumber: e.invoiceNumber,
            vendorId: vendor?.id ?? null,
            invoiceDate,
            dueDate: parseDate(e.dueDate),
            currency: e.currency,
            subtotal: e.subtotal,
            tax: e.tax,
            total: e.total,
            purchaseOrderNumber: e.purchaseOrderNumber,
            paymentTerms: e.paymentTerms,
            aiConfidence: inv.useStoredData ? inv.aiConfidence ?? e.confidence : e.confidence,
            extraction: inv.useStoredData ? undefined : (raw as unknown as Prisma.InputJsonValue),
            validation: { findings: validation, derivedFields: derived, tolerance } as any,
            anomalies: anomalies as any,
            aiAnalysis: analysis as any,
            riskLevel: level,
            riskScore: score,
            duplicateDetected: dup.duplicate,
            duplicateOfId: dup.duplicateOfId,
            autoApproved: false,
            approvedAt: null,
            approvedBy: null,
            rejectedAt: null,
            rejectedBy: null,
            rejectionReason: null,
            exceptionReasons: [],
            failureReason: null,
          },
        });
        await audit({ organizationId, action: 'invoice.validated', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { findings: findings.map((f) => f.code), risk: level, score } }, tx);
        if (dup.duplicate) {
          await audit({ organizationId, action: 'invoice.duplicate_detected', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { duplicateOf: dup.duplicateOfId, reasons: dup.reasons } }, tx);
          for (const userId of await usersWithRole(organizationId, 'FINANCE_MANAGER', tx)) {
            await notifyUser({ organizationId, userId, type: 'DUPLICATE', title: 'Duplicate invoice detected', message: `Invoice ${e.invoiceNumber ?? invoiceId.slice(0, 8)} appears to be a duplicate (${dup.reasons.join(', ')}).`, invoiceId, dedupeKey: `dup:${invoiceId}:run-${run}` }, tx);
          }
        }

        const result = await runEvent({
          tx,
          organizationId,
          invoiceId,
          triggers,
          runKey: `run-${run}`,
          safety: { blocking, exceptionReasons },
        });

        await tx.invoice.update({
          where: { id: invoiceId },
          data: { completedRun: run, lockedAt: null, processingStatus: 'COMPLETED', processedAt: new Date(), processingMs: Date.now() - started, retryCount: 0 },
        });
        await audit({ organizationId, action: 'invoice.processed', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { status: result.applied?.status, decidedBy: result.decisionSource, override: result.systemOverride, run } }, tx);
        return result;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    await prisma.aIProcessingJob.update({ where: { id: aiJob.id }, data: { status: 'COMPLETED', completedAt: new Date(), durationMs: Date.now() - started } });

    // Deferred (post-commit) AI analysis requested by TRIGGER_AI_ANALYSIS actions. Failures are non-fatal.
    if (outcome.deferred.length && provider) {
      try {
        const a = await provider.analyzeInvoice({ extraction: e, findings, riskLevel: level });
        await prisma.invoice.update({ where: { id: invoiceId }, data: { aiAnalysis: { ...a, source: provider.name, reanalyzed: true } as any } });
      } catch {
        /* ignore */
      }
    }
    const final = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } });
    return { skipped: false, status: final.status, decidedBy: outcome.decisionSource };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.aIProcessingJob.update({ where: { id: aiJob.id }, data: { status: 'FAILED', error: message.slice(0, 500), completedAt: new Date(), durationMs: Date.now() - started } }).catch(() => undefined);
    // release the lock so a retry can re-claim the invoice
    await prisma.invoice.update({ where: { id: invoiceId }, data: { lockedAt: null, processingStatus: 'QUEUED', retryCount: { increment: 1 } } }).catch(() => undefined);
    throw err;
  }
}

/** Called once retries are exhausted (or the error is non-retryable). Moves the invoice to the exception queue as FAILED. */
export async function markProcessingFailed(invoiceId: string, run: number, reason: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!inv || inv.completedRun >= run) return;
  const msg = reason.slice(0, 500);
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: 'FAILED', processingStatus: 'FAILED', lockedAt: null, failureReason: msg, exceptionReasons: [`Processing failed: ${msg}`] },
    });
    await audit({ organizationId: inv.organizationId, action: 'invoice.processing_failed', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { reason: msg, run } }, tx);
    const recipients = new Set<string>(await usersWithRole(inv.organizationId, 'FINANCE_MANAGER', tx));
    if (inv.uploadedBy) recipients.add(inv.uploadedBy);
    for (const userId of recipients) {
      await notifyUser({ organizationId: inv.organizationId, userId, type: 'PROCESSING_FAILED', title: 'Invoice processing failed', message: `Processing failed for ${inv.fileName ?? invoiceId.slice(0, 8)}: ${msg}`, invoiceId, dedupeKey: `failed:${invoiceId}:run-${run}` }, tx);
    }
  });
}
