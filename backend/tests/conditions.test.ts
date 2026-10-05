import { describe, expect, it } from 'vitest';
import { evaluateTree, flattenTrace, validateConditionTree } from '../src/rules/conditions';
import { RuleContext } from '../src/rules/fields';

const ctx = (o: Partial<RuleContext['invoice']> = {}, vendor: RuleContext['vendor'] = { id: 'v1', name: 'Acme Supplies', industry: 'IT', group: 'preferred' }): RuleContext => ({
  invoice: { id: 'i1', invoiceNumber: 'A1', total: 75000, subtotal: 70000, tax: 5000, taxRate: 7.14, currency: 'INR', invoiceDate: new Date('2026-09-01'), dueDate: new Date('2026-10-01'), riskLevel: 'HIGH', purchaseOrderPresent: false, duplicateDetected: false, aiConfidence: 92, uploadedBy: 'u1', ...o },
  vendor,
});
const leaf = (field: string, operator: string, value: any) => ({ field, operator, value });

describe('condition evaluation', () => {
  it('AND requires every condition', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'greater_than', 50000), leaf('invoice.riskLevel', 'equals', 'HIGH')] });
    expect(evaluateTree(t, ctx()).matched).toBe(true);
    expect(evaluateTree(t, ctx({ riskLevel: 'LOW' })).matched).toBe(false);
  });

  it('OR needs just one', () => {
    const t = validateConditionTree({ operator: 'OR', conditions: [leaf('invoice.total', 'greater_than', 100000), leaf('invoice.riskLevel', 'equals', 'CRITICAL')] });
    expect(evaluateTree(t, ctx()).matched).toBe(false);
    expect(evaluateTree(t, ctx({ riskLevel: 'CRITICAL' })).matched).toBe(true);
    expect(evaluateTree(t, ctx({ total: 150000 })).matched).toBe(true);
  });

  it('supports nested groups: (total>100000 AND risk=HIGH) OR duplicate', () => {
    const t = validateConditionTree({
      operator: 'OR',
      conditions: [{ operator: 'AND', conditions: [leaf('invoice.total', 'greater_than', 100000), leaf('invoice.riskLevel', 'equals', 'HIGH')] }, leaf('invoice.duplicateDetected', 'equals', true)],
    });
    expect(evaluateTree(t, ctx()).matched).toBe(false);
    expect(evaluateTree(t, ctx({ duplicateDetected: true })).matched).toBe(true);
    expect(evaluateTree(t, ctx({ total: 200000 })).matched).toBe(true);
  });

  it('compares risk levels by severity and handles != LOW', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.riskLevel', 'not_equals', 'LOW')] });
    expect(evaluateTree(t, ctx({ riskLevel: 'MEDIUM' })).matched).toBe(true);
    expect(evaluateTree(t, ctx({ riskLevel: 'LOW' })).matched).toBe(false);
    const gte = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.riskLevel', 'greater_than_or_equal', 'HIGH')] });
    expect(evaluateTree(gte, ctx({ riskLevel: 'CRITICAL' })).matched).toBe(true);
    expect(evaluateTree(gte, ctx({ riskLevel: 'MEDIUM' })).matched).toBe(false);
  });

  it('string operators are case-insensitive; contains works', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('vendor.name', 'contains', 'ACME')] });
    expect(evaluateTree(t, ctx()).matched).toBe(true);
    const e = validateConditionTree({ operator: 'AND', conditions: [leaf('vendor.group', 'equals', 'Preferred')] });
    expect(evaluateTree(e, ctx()).matched).toBe(true);
  });

  it('null values never satisfy comparisons (except not_equals)', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'less_than', 1000000)] });
    expect(evaluateTree(t, ctx({ total: null })).matched).toBe(false);
    const n = validateConditionTree({ operator: 'AND', conditions: [leaf('vendor.name', 'not_equals', 'X')] });
    expect(evaluateTree(n, ctx({}, null)).matched).toBe(true);
  });

  it('date comparisons work', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.dueDate', 'less_than', '2026-12-31')] });
    expect(evaluateTree(t, ctx()).matched).toBe(true);
  });

  it('produces a full trace without short-circuiting', () => {
    const t = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'greater_than', 999999), leaf('invoice.riskLevel', 'equals', 'HIGH')] });
    const leaves = flattenTrace(evaluateTree(t, ctx()));
    expect(leaves).toHaveLength(2);
    expect(leaves.map((l) => l.matched)).toEqual([false, true]);
    expect(leaves[0].actual).toBe(75000);
  });
});

describe('condition validation (rule engine safety)', () => {
  it('rejects unsupported fields and operators', () => {
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.secret', 'equals', 1)] })).toThrow(/Unsupported field/);
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'matches_regex', 1)] })).toThrow(/Unsupported operator/);
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.currency', 'greater_than', 'INR')] })).toThrow(/cannot be used/);
  });
  it('rejects bad values, empty groups and bad group operators', () => {
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'equals', 'abc')] })).toThrow(/numeric/);
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.riskLevel', 'equals', 'EXTREME')] })).toThrow();
    expect(() => validateConditionTree({ operator: 'AND', conditions: [] })).toThrow(/at least one/);
    expect(() => validateConditionTree({ operator: 'XOR', conditions: [leaf('invoice.total', 'equals', 1)] })).toThrow(/AND or OR/);
  });
  it('rejects excessive nesting and never accepts code', () => {
    let node: any = leaf('invoice.total', 'equals', 1);
    for (let i = 0; i < 8; i++) node = { operator: 'AND', conditions: [node] };
    expect(() => validateConditionTree(node)).toThrow(/nested/);
    expect(() => validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'equals', 'process.exit(1)')] })).toThrow();
  });
  it('coerces numeric strings and boolean strings', () => {
    const t: any = validateConditionTree({ operator: 'AND', conditions: [leaf('invoice.total', 'greater_than', '50,000'), leaf('invoice.duplicateDetected', 'equals', 'false')] });
    expect(t.conditions[0].value).toBe(50000);
    expect(t.conditions[1].value).toBe(false);
  });
});
