import { RuleTrigger } from '@prisma/client';
import { ConditionNode } from './conditions';
import { RuleAction } from './actions';

export interface RuleTemplate {
  key: string;
  name: string;
  description: string;
  trigger: RuleTrigger;
  priority: number;
  conditions: ConditionNode;
  actions: RuleAction[];
  /** Created automatically for every new organization (editable/deletable afterwards). */
  isDefault: boolean;
}

const and = (...conditions: ConditionNode[]): ConditionNode => ({ operator: 'AND', conditions });

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    key: 'duplicate-review',
    name: 'Duplicate Invoice Review',
    description: 'Send suspected duplicates to the exception queue and alert the finance manager.',
    trigger: 'DUPLICATE_DETECTED',
    priority: 1,
    isDefault: true,
    conditions: and({ field: 'invoice.duplicateDetected', operator: 'equals', value: true }),
    actions: [
      { type: 'MOVE_TO_EXCEPTION_QUEUE', reason: 'Possible duplicate invoice' },
      { type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER', title: 'Duplicate invoice detected', message: 'Invoice {{invoiceNumber}} from {{vendorName}} ({{total}}) looks like a duplicate.' },
    ],
  },
  {
    key: 'critical-risk-review',
    name: 'Critical Risk Review',
    description: 'Critical-risk invoices always get a human review and notify an admin.',
    trigger: 'INVOICE_PROCESSED',
    priority: 2,
    isDefault: true,
    conditions: and({ field: 'invoice.riskLevel', operator: 'equals', value: 'CRITICAL' }),
    actions: [
      { type: 'REQUEST_HUMAN_REVIEW', reason: 'Critical risk level' },
      { type: 'SEND_NOTIFICATION', recipient: 'ADMIN', title: 'Critical-risk invoice', message: 'Invoice {{invoiceNumber}} from {{vendorName}} ({{total}}) is CRITICAL risk.' },
    ],
  },
  {
    key: 'missing-po',
    name: 'Missing Purchase Order',
    description: 'Large invoices without a purchase order need manual review.',
    trigger: 'INVOICE_PROCESSED',
    priority: 3,
    isDefault: true,
    conditions: and({ field: 'invoice.purchaseOrderPresent', operator: 'equals', value: false }, { field: 'invoice.total', operator: 'greater_than', value: 25000 }),
    actions: [{ type: 'REQUEST_HUMAN_REVIEW', reason: 'Missing purchase order on a high-value invoice' }, { type: 'ADD_TAG', tag: 'Missing PO' }],
  },
  {
    key: 'low-confidence-review',
    name: 'Low AI Confidence Review',
    description: 'When the AI is not confident in its extraction, a human must check it.',
    trigger: 'INVOICE_PROCESSED',
    priority: 4,
    isDefault: true,
    conditions: and({ field: 'invoice.aiConfidence', operator: 'less_than', value: 70 }),
    actions: [{ type: 'REQUEST_HUMAN_REVIEW', reason: 'AI confidence below 70%' }],
  },
  {
    key: 'admin-approval',
    name: 'Admin Approval (≥ 100,000)',
    description: 'Very large invoices need admin approval.',
    trigger: 'INVOICE_PROCESSED',
    priority: 5,
    isDefault: true,
    conditions: and({ field: 'invoice.total', operator: 'greater_than_or_equal', value: 100000 }),
    actions: [
      { type: 'REQUIRE_APPROVAL', role: 'ADMIN' },
      { type: 'SEND_NOTIFICATION', recipient: 'ADMIN' },
      { type: 'ADD_TAG', tag: 'High Value' },
    ],
  },
  {
    key: 'manager-approval',
    name: 'Manager Approval (10,000 – 100,000)',
    description: 'Mid-value invoices need finance manager approval.',
    trigger: 'INVOICE_PROCESSED',
    priority: 6,
    isDefault: true,
    conditions: and({ field: 'invoice.total', operator: 'greater_than_or_equal', value: 10000 }, { field: 'invoice.total', operator: 'less_than', value: 100000 }),
    actions: [{ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' }, { type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER' }],
  },
  {
    key: 'low-value-auto-approval',
    name: 'Low Value Auto Approval',
    description: 'Small, low-risk, confidently-extracted invoices are approved automatically.',
    trigger: 'INVOICE_PROCESSED',
    priority: 7,
    isDefault: true,
    conditions: and(
      { field: 'invoice.total', operator: 'less_than', value: 10000 },
      { field: 'invoice.riskLevel', operator: 'equals', value: 'LOW' },
      { field: 'invoice.aiConfidence', operator: 'greater_than_or_equal', value: 70 },
    ),
    actions: [{ type: 'AUTO_APPROVE' }, { type: 'SEND_NOTIFICATION', recipient: 'UPLOADER' }],
  },
  // ---- extra templates (not created by default) ----
  {
    key: 'multi-level-very-high',
    name: 'Multi-level Approval for Very High Value',
    description: 'Finance manager first, then admin, for invoices ≥ 500,000.',
    trigger: 'INVOICE_PROCESSED',
    priority: 4,
    isDefault: false,
    conditions: and({ field: 'invoice.total', operator: 'greater_than_or_equal', value: 500000 }),
    actions: [{ type: 'REQUIRE_MULTI_LEVEL_APPROVAL', levels: [{ role: 'FINANCE_MANAGER' }, { role: 'ADMIN' }] }, { type: 'ADD_TAG', tag: 'Very High Value' }],
  },
  {
    key: 'high-risk-high-value',
    name: 'High Value + Elevated Risk',
    description: 'Approval, notification, tag and follow-up task for risky large invoices.',
    trigger: 'INVOICE_PROCESSED',
    priority: 3,
    isDefault: false,
    conditions: and({ field: 'invoice.total', operator: 'greater_than', value: 75000 }, { field: 'invoice.riskLevel', operator: 'not_equals', value: 'LOW' }),
    actions: [
      { type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' },
      { type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER', message: 'Invoice {{invoiceNumber}} requires approval. Vendor: {{vendorName}}. Amount: {{total}}.' },
      { type: 'ADD_TAG', tag: 'High Risk' },
      { type: 'CREATE_TASK', title: 'Review invoice {{invoiceNumber}}', priority: 'HIGH', assignTo: 'FINANCE_MANAGER', dueInDays: 2 },
    ],
  },
];
