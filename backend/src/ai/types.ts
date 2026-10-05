import { z } from 'zod';

const nullableString = z.preprocess((v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || ['UNKNOWN', 'N/A', 'NULL'].includes(t.toUpperCase()) ? null : t;
  }
  return v;
}, z.string().nullable());

const nullableNumber = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') {
    if (v.trim().toUpperCase() === 'UNKNOWN') return null;
    const n = Number(v.replace(/[, ]/g, ''));
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number().finite().nullable());

const nullableDate = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() && v.trim().toUpperCase() !== 'UNKNOWN' ? v.trim() : null),
  z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Expected YYYY-MM-DD').nullable(),
);

export const LineItemSchema = z.object({
  description: z.preprocess((v) => (v == null ? 'Item' : v), z.string()),
  quantity: z.preprocess((v) => (v == null ? 1 : typeof v === 'string' ? Number(v) : v), z.number().finite()),
  unitPrice: z.preprocess((v) => (v == null ? 0 : typeof v === 'string' ? Number(v) : v), z.number().finite()),
  taxRate: nullableNumber.optional().default(null),
  taxAmount: nullableNumber.optional().default(null),
  lineTotal: nullableNumber.optional().default(null),
});

export const ExtractedInvoiceSchema = z.object({
  invoiceNumber: nullableString,
  vendorName: nullableString,
  vendorTaxId: nullableString,
  invoiceDate: nullableDate,
  dueDate: nullableDate,
  currency: nullableString,
  subtotal: nullableNumber,
  tax: nullableNumber,
  total: nullableNumber,
  purchaseOrderNumber: nullableString,
  paymentTerms: nullableString,
  lineItems: z.array(LineItemSchema).default([]),
  confidence: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().min(0).max(1)),
});

export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;
export type ExtractedLineItem = z.infer<typeof LineItemSchema>;

export interface ExtractInput {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface AnalysisInput {
  extraction: ExtractedInvoice;
  findings: { code: string; severity: string; message: string }[];
  riskLevel: string;
}

export interface AnalysisOutput {
  explanation: string;
  aiScore: number; // 0-100, higher = more concerning
}

export interface AIProvider {
  readonly name: 'gemini' | 'mock';
  readonly model: string;
  extractInvoice(input: ExtractInput): Promise<ExtractedInvoice>;
  analyzeInvoice(input: AnalysisInput): Promise<AnalysisOutput>;
  generateInsight(stats: Record<string, unknown>): Promise<string>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public retryable = true,
  ) {
    super(message);
  }
}
