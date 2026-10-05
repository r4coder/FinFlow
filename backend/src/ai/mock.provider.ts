import { createHash } from 'node:crypto';
import { AIProvider, AnalysisInput, AnalysisOutput, ExtractedInvoice, ExtractedInvoiceSchema, ExtractInput } from './types';

const VENDORS = [
  { name: 'Northwind Logistics Pvt Ltd', taxId: '29AABCN1234F1Z5' },
  { name: 'Apex Office Supplies', taxId: '27AAFCA9876K1ZB' },
  { name: 'BlueOrbit Cloud Services', taxId: '36AAECB4567M1Z2' },
  { name: 'Greenfield Facilities Co', taxId: '33AAACG2345H1ZP' },
  { name: 'Quantum Print & Packaging', taxId: '07AAHCQ7788L1Z9' },
];

const MARKER = 'MOCKDATA:';

/**
 * Deterministic demo extraction (no network, no API key).
 *
 * - By default the result is derived from a SHA-256 hash of the file, so the same file always yields the same data.
 * - Demo/test hook: if the file contains a `MOCKDATA:{...json...}` marker, that JSON is used as the extraction
 *   (this is how the seed script and the automated tests create invoices with specific amounts).
 *   This hook only exists in the mock provider; the Gemini provider never reads it.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-deterministic-v1';

  async extractInvoice(input: ExtractInput): Promise<ExtractedInvoice> {
    const text = input.buffer.toString('latin1');
    const idx = text.indexOf(MARKER);
    if (idx >= 0) {
      const line = text.slice(idx + MARKER.length).split(/\r?\n/)[0];
      try {
        return ExtractedInvoiceSchema.parse(JSON.parse(line));
      } catch {
        throw new Error('MOCKDATA marker contains invalid JSON');
      }
    }
    const h = createHash('sha256').update(input.buffer).digest();
    const vendor = VENDORS[h[0] % VENDORS.length];
    const items = 1 + (h[1] % 3);
    const lineItems = Array.from({ length: items }, (_, i) => {
      const quantity = 1 + (h[2 + i] % 10);
      const unitPrice = 500 + (h[6 + i] % 90) * 100;
      const taxRate = 18;
      const base = quantity * unitPrice;
      return {
        description: ['Consulting services', 'Equipment rental', 'Monthly subscription', 'Maintenance contract'][h[10 + i] % 4],
        quantity,
        unitPrice,
        taxRate,
        taxAmount: Math.round(base * 0.18 * 100) / 100,
        lineTotal: base,
      };
    });
    const subtotal = lineItems.reduce((a, l) => a + (l.lineTotal ?? 0), 0);
    const tax = Math.round(subtotal * 0.18 * 100) / 100;
    const day = 1 + (h[14] % 27);
    const month = 1 + (h[15] % 9);
    const invoiceDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const due = new Date(Date.parse(invoiceDate) + 30 * 86400000).toISOString().slice(0, 10);
    return ExtractedInvoiceSchema.parse({
      invoiceNumber: `INV-${String(h[16] * 256 + h[17]).padStart(5, '0')}`,
      vendorName: vendor.name,
      vendorTaxId: vendor.taxId,
      invoiceDate,
      dueDate: due,
      currency: 'INR',
      subtotal,
      tax,
      total: Math.round((subtotal + tax) * 100) / 100,
      purchaseOrderNumber: h[18] % 3 === 0 ? null : `PO-${1000 + (h[19] % 900)}`,
      paymentTerms: 'Net 30',
      lineItems,
      confidence: 0.9,
    });
  }

  async analyzeInvoice(input: AnalysisInput): Promise<AnalysisOutput> {
    const issues = input.findings.map((f) => f.message);
    const score = Math.min(100, input.findings.reduce((a, f) => a + (f.severity === 'high' ? 30 : f.severity === 'medium' ? 15 : 5), 0));
    return {
      aiScore: score,
      explanation: issues.length
        ? `Risk is ${input.riskLevel}. Findings: ${issues.join('; ')}.`
        : `No issues found. Risk is ${input.riskLevel}.`,
    };
  }

  async generateInsight(stats: Record<string, unknown>): Promise<string> {
    return `Demo insight (mock AI): processed ${stats.processed ?? 0} invoices.`;
  }
}
