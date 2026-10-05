import { RiskLevel, RuleTrigger } from '@prisma/client';

export type FieldType = 'number' | 'string' | 'boolean' | 'date' | 'risk';

export const OPERATORS = ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'contains'] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Record<Operator, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  greater_than: 'is greater than',
  greater_than_or_equal: 'is greater than or equal to',
  less_than: 'is less than',
  less_than_or_equal: 'is less than or equal to',
  contains: 'contains',
};

const NUM_OPS: Operator[] = ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'];
const STR_OPS: Operator[] = ['equals', 'not_equals', 'contains'];
const BOOL_OPS: Operator[] = ['equals', 'not_equals'];

export interface FieldDef {
  label: string;
  type: FieldType;
  operators: Operator[];
  group: string;
  options?: string[];
  help?: string;
}

export const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** The ONLY fields a rule may reference. Anything else is rejected at save time. */
export const FIELD_CATALOG: Record<string, FieldDef> = {
  'invoice.total': { label: 'Invoice total', type: 'number', operators: NUM_OPS, group: 'Amount' },
  'invoice.subtotal': { label: 'Invoice subtotal', type: 'number', operators: NUM_OPS, group: 'Amount' },
  'invoice.tax': { label: 'Tax amount', type: 'number', operators: NUM_OPS, group: 'Amount' },
  'invoice.taxRate': { label: 'Effective tax rate (%)', type: 'number', operators: NUM_OPS, group: 'Amount', help: 'tax ÷ subtotal × 100' },
  'invoice.currency': { label: 'Currency', type: 'string', operators: ['equals', 'not_equals'], group: 'Invoice' },
  'invoice.invoiceDate': { label: 'Invoice date', type: 'date', operators: NUM_OPS, group: 'Invoice', help: 'YYYY-MM-DD' },
  'invoice.dueDate': { label: 'Due date', type: 'date', operators: NUM_OPS, group: 'Invoice', help: 'YYYY-MM-DD' },
  'invoice.riskLevel': { label: 'Risk level', type: 'risk', operators: NUM_OPS, group: 'Risk', options: RISK_ORDER },
  'invoice.duplicateDetected': { label: 'Duplicate detected', type: 'boolean', operators: BOOL_OPS, group: 'Risk' },
  'invoice.purchaseOrderPresent': { label: 'Purchase order present', type: 'boolean', operators: BOOL_OPS, group: 'Invoice' },
  'invoice.aiConfidence': { label: 'AI confidence (%)', type: 'number', operators: NUM_OPS, group: 'AI', help: '0–100' },
  'vendor.name': { label: 'Vendor name', type: 'string', operators: STR_OPS, group: 'Vendor' },
  'vendor.id': { label: 'Specific vendor', type: 'string', operators: ['equals', 'not_equals'], group: 'Vendor' },
  'vendor.industry': { label: 'Vendor industry', type: 'string', operators: STR_OPS, group: 'Vendor' },
  'vendor.group': { label: 'Vendor group', type: 'string', operators: STR_OPS, group: 'Vendor' },
};

export const TRIGGER_LABELS: Record<RuleTrigger, string> = {
  INVOICE_UPLOADED: 'Invoice uploaded',
  INVOICE_PROCESSED: 'Invoice processed',
  INVOICE_VALIDATION_FAILED: 'Validation failed',
  DUPLICATE_DETECTED: 'Duplicate detected',
  ANOMALY_DETECTED: 'Anomaly detected',
  APPROVAL_REQUESTED: 'Approval requested',
  APPROVAL_COMPLETED: 'Approval completed',
  INVOICE_APPROVED: 'Invoice approved',
  INVOICE_REJECTED: 'Invoice rejected',
};

/** Triggers evaluated BEFORE the invoice's disposition is decided. Only these may carry decision actions. */
export const DECISION_TRIGGERS: RuleTrigger[] = ['INVOICE_PROCESSED', 'INVOICE_VALIDATION_FAILED', 'DUPLICATE_DETECTED', 'ANOMALY_DETECTED'];

export interface RuleContext {
  invoice: {
    id: string;
    invoiceNumber: string | null;
    total: number | null;
    subtotal: number | null;
    tax: number | null;
    taxRate: number | null;
    currency: string | null;
    invoiceDate: Date | null;
    dueDate: Date | null;
    riskLevel: RiskLevel | null;
    purchaseOrderPresent: boolean;
    duplicateDetected: boolean;
    aiConfidence: number | null; // 0-100
    uploadedBy: string | null;
  };
  vendor: { id: string; name: string; industry: string | null; group: string | null } | null;
}

export function getFieldValue(ctx: RuleContext, field: string): unknown {
  const [scope, key] = field.split('.');
  if (scope === 'vendor') return ctx.vendor ? (ctx.vendor as Record<string, unknown>)[key] ?? null : null;
  return (ctx.invoice as Record<string, unknown>)[key] ?? null;
}
