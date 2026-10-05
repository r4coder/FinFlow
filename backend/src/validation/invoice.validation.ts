import { RiskLevel } from '@prisma/client';
import { ExtractedInvoice } from '../ai/types';
import { round2 } from '../utils/money';

export type Severity = 'low' | 'medium' | 'high';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  field?: string;
  /** Blocking findings prevent automatic approval (system safety floor). */
  blocking?: boolean;
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Deterministic validation. No AI involved: all arithmetic is done by code. */
export function validateExtraction(e: ExtractedInvoice, tolerance = 0.05): Finding[] {
  const out: Finding[] = [];
  const required: [keyof ExtractedInvoice, string, boolean][] = [
    ['invoiceNumber', 'Invoice number', true],
    ['vendorName', 'Vendor name', true],
    ['total', 'Total amount', true],
    ['invoiceDate', 'Invoice date', false],
    ['currency', 'Currency', false],
  ];
  for (const [field, label, blocking] of required) {
    if (e[field] === null || e[field] === undefined) {
      out.push({ code: 'MISSING_FIELD', severity: blocking ? 'high' : 'medium', message: `${label} is missing`, field: String(field), blocking });
    }
  }

  const { subtotal, tax, total } = e;
  for (const [k, v] of Object.entries({ subtotal, tax, total })) {
    if (v !== null && v < 0) out.push({ code: 'NEGATIVE_AMOUNT', severity: 'high', message: `${k} is negative`, field: k, blocking: true });
  }

  if (subtotal !== null && tax !== null && total !== null && !close(subtotal + tax, total, tolerance)) {
    out.push({
      code: 'TOTAL_MISMATCH',
      severity: 'high',
      message: `Subtotal (${subtotal}) + tax (${tax}) = ${round2(subtotal + tax)} does not match total (${total})`,
      field: 'total',
      blocking: true,
    });
  }

  e.lineItems.forEach((li, i) => {
    if (li.lineTotal !== null && !close(li.quantity * li.unitPrice, li.lineTotal, tolerance)) {
      out.push({
        code: 'LINE_TOTAL_MISMATCH',
        severity: 'medium',
        message: `Line ${i + 1}: ${li.quantity} × ${li.unitPrice} = ${round2(li.quantity * li.unitPrice)} but line total is ${li.lineTotal}`,
        field: `lineItems.${i}`,
      });
    }
  });

  if (e.lineItems.length && subtotal !== null && e.lineItems.every((l) => l.lineTotal !== null)) {
    const sum = e.lineItems.reduce((a, l) => a + (l.lineTotal ?? 0), 0);
    if (!close(sum, subtotal, Math.max(tolerance, tolerance * e.lineItems.length))) {
      out.push({ code: 'SUBTOTAL_MISMATCH', severity: 'medium', message: `Line items sum to ${round2(sum)} but subtotal is ${subtotal}`, field: 'subtotal' });
    }
  }

  if (tax !== null && e.lineItems.length && e.lineItems.every((l) => l.taxAmount !== null)) {
    const sum = e.lineItems.reduce((a, l) => a + (l.taxAmount ?? 0), 0);
    if (!close(sum, tax, Math.max(tolerance, tolerance * e.lineItems.length))) {
      out.push({ code: 'TAX_MISMATCH', severity: 'medium', message: `Line-item tax sums to ${round2(sum)} but invoice tax is ${tax}`, field: 'tax' });
    }
  }

  if (e.invoiceDate && e.dueDate) {
    const a = Date.parse(e.invoiceDate);
    const b = Date.parse(e.dueDate);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      out.push({ code: 'INVALID_DATE', severity: 'medium', message: 'Invoice or due date could not be parsed', field: 'dueDate' });
    } else if (b < a) {
      out.push({ code: 'INVALID_DATE', severity: 'medium', message: 'Due date is earlier than invoice date', field: 'dueDate' });
    }
  } else if (e.invoiceDate && Number.isNaN(Date.parse(e.invoiceDate))) {
    out.push({ code: 'INVALID_DATE', severity: 'medium', message: 'Invoice date could not be parsed', field: 'invoiceDate' });
  }
  return out;
}

export interface AnomalyContext {
  extraction: ExtractedInvoice;
  unknownVendor: boolean;
  duplicate: boolean;
  vendorHistory: { count: number; average: number | null };
  highAmountMultiplier: number;
  confidenceThreshold?: number;
}

export function detectAnomalies(ctx: AnomalyContext): Finding[] {
  const out: Finding[] = [];
  const e = ctx.extraction;
  if (!e.purchaseOrderNumber) out.push({ code: 'MISSING_PO', severity: 'low', message: 'No purchase order number on the invoice', field: 'purchaseOrderNumber' });
  if (ctx.unknownVendor) out.push({ code: 'UNKNOWN_VENDOR', severity: 'medium', message: 'Vendor is not in the vendor master (unverified)', field: 'vendorName' });
  if (ctx.duplicate) out.push({ code: 'DUPLICATE_INVOICE', severity: 'high', message: 'Possible duplicate of an existing invoice', blocking: true });
  if (e.total !== null && ctx.vendorHistory.count >= 3 && ctx.vendorHistory.average && e.total > ctx.vendorHistory.average * ctx.highAmountMultiplier) {
    out.push({
      code: 'HIGH_AMOUNT',
      severity: 'medium',
      message: `Amount ${e.total} is more than ${ctx.highAmountMultiplier}× this vendor's average (${round2(ctx.vendorHistory.average)})`,
      field: 'total',
    });
  }
  if (e.confidence < (ctx.confidenceThreshold ?? 0.7)) {
    out.push({ code: 'LOW_CONFIDENCE', severity: 'medium', message: `AI confidence is low (${Math.round(e.confidence * 100)}%)`, field: 'confidence' });
  }
  return out;
}

const WEIGHTS: Record<string, number> = {
  DUPLICATE_INVOICE: 60,
  TOTAL_MISMATCH: 40,
  NEGATIVE_AMOUNT: 40,
  MISSING_FIELD: 25,
  HIGH_AMOUNT: 25,
  TAX_MISMATCH: 20,
  UNKNOWN_VENDOR: 20,
  LOW_CONFIDENCE: 20,
  INVALID_DATE: 15,
  LINE_TOTAL_MISMATCH: 10,
  SUBTOTAL_MISMATCH: 10,
  MISSING_PO: 10,
};

export function scoreRisk(findings: Finding[]): { score: number; level: RiskLevel } {
  const score = findings.reduce((a, f) => a + (WEIGHTS[f.code] ?? 5), 0);
  let level: RiskLevel = score >= 70 ? 'CRITICAL' : score >= 40 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';
  if (findings.some((f) => f.code === 'DUPLICATE_INVOICE') && (level === 'LOW' || level === 'MEDIUM')) level = 'HIGH';
  return { score, level };
}
