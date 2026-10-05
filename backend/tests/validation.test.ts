import { describe, expect, it } from 'vitest';
import { detectAnomalies, scoreRisk, validateExtraction } from '../src/validation/invoice.validation';
import { ExtractedInvoiceSchema } from '../src/ai/types';

const base = (o: object = {}) =>
  ExtractedInvoiceSchema.parse({ invoiceNumber: 'A1', vendorName: 'V', invoiceDate: '2026-09-01', dueDate: '2026-10-01', currency: 'INR', subtotal: 1000, tax: 180, total: 1180, purchaseOrderNumber: 'PO1', lineItems: [{ description: 'x', quantity: 2, unitPrice: 500, taxAmount: 180, lineTotal: 1000 }], confidence: 0.9, ...o });

describe('deterministic validation', () => {
  it('passes a consistent invoice', () => expect(validateExtraction(base())).toEqual([]));
  it('detects subtotal + tax != total (blocking)', () => {
    const f = validateExtraction(base({ total: 1300 }));
    expect(f.find((x) => x.code === 'TOTAL_MISMATCH')?.blocking).toBe(true);
  });
  it('respects the rounding tolerance', () => {
    expect(validateExtraction(base({ total: 1180.03 }), 0.05)).toEqual([]);
    expect(validateExtraction(base({ total: 1180.03 }), 0.01).some((f) => f.code === 'TOTAL_MISMATCH')).toBe(true);
  });
  it('detects line total, subtotal and tax sum mismatches', () => {
    const codes = validateExtraction(base({ lineItems: [{ description: 'x', quantity: 2, unitPrice: 500, taxAmount: 100, lineTotal: 900 }] })).map((f) => f.code);
    expect(codes).toContain('LINE_TOTAL_MISMATCH');
    expect(codes).toContain('SUBTOTAL_MISMATCH');
    expect(codes).toContain('TAX_MISMATCH');
  });
  it('flags due date before invoice date and missing required fields', () => {
    expect(validateExtraction(base({ dueDate: '2026-08-01' })).some((f) => f.code === 'INVALID_DATE')).toBe(true);
    const f = validateExtraction(base({ invoiceNumber: null, total: null }));
    expect(f.filter((x) => x.code === 'MISSING_FIELD').length).toBe(2);
  });
  it('normalizes AI "UNKNOWN" and numeric strings instead of inventing values', () => {
    const e = ExtractedInvoiceSchema.parse({ invoiceNumber: 'UNKNOWN', vendorName: ' ', total: '1,234.50', lineItems: [], confidence: '0.5' });
    expect(e.invoiceNumber).toBeNull();
    expect(e.vendorName).toBeNull();
    expect(e.total).toBe(1234.5);
    expect(e.confidence).toBe(0.5);
  });
  it('rejects structurally invalid AI output', () => {
    expect(ExtractedInvoiceSchema.safeParse({ lineItems: 'nope', confidence: 2 }).success).toBe(false);
  });
});

describe('anomalies and risk', () => {
  const ctx = (o: object = {}) => ({ extraction: base(), unknownVendor: false, duplicate: false, vendorHistory: { count: 0, average: null }, highAmountMultiplier: 3, ...o });
  it('flags missing PO, unknown vendor, duplicate, low confidence, unusually high amount', () => {
    const codes = detectAnomalies(ctx({ extraction: base({ purchaseOrderNumber: null, confidence: 0.4, total: 100000, subtotal: 100000, tax: 0 }), unknownVendor: true, duplicate: true, vendorHistory: { count: 5, average: 1000 } })).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['MISSING_PO', 'UNKNOWN_VENDOR', 'DUPLICATE_INVOICE', 'LOW_CONFIDENCE', 'HIGH_AMOUNT']));
  });
  it('risk levels scale with findings; duplicates are at least HIGH', () => {
    expect(scoreRisk([]).level).toBe('LOW');
    expect(scoreRisk(detectAnomalies(ctx({ extraction: base({ purchaseOrderNumber: null }) }))).level).toBe('LOW');
    expect(scoreRisk(detectAnomalies(ctx({ unknownVendor: true }))).level).toBe('MEDIUM');
    expect(scoreRisk(detectAnomalies(ctx({ duplicate: true }))).level).toBe('HIGH');
    const big = [...validateExtraction(base({ total: 9999 })), ...detectAnomalies(ctx({ duplicate: true }))];
    expect(scoreRisk(big).level).toBe('CRITICAL');
  });
});
