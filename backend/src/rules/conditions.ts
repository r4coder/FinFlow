import { badRequest } from '../utils/errors';
import { FIELD_CATALOG, getFieldValue, Operator, OPERATORS, RISK_ORDER, RuleContext, OPERATOR_LABELS } from './fields';

export interface ConditionLeaf {
  field: string;
  operator: Operator;
  value: string | number | boolean;
}
export interface ConditionGroup {
  operator: 'AND' | 'OR';
  conditions: ConditionNode[];
}
export type ConditionNode = ConditionLeaf | ConditionGroup;

export const isGroup = (n: ConditionNode): n is ConditionGroup => 'conditions' in n;

export const MAX_DEPTH = 5;
export const MAX_LEAVES = 50;

const invalid = (m: string) => badRequest(m, 'INVALID_RULE');

/** Validates structure + semantics of a condition tree and returns a normalized copy (values coerced to field type). */
export function validateConditionTree(input: unknown): ConditionNode {
  let leaves = 0;
  const walk = (node: any, depth: number): ConditionNode => {
    if (depth > MAX_DEPTH) throw invalid(`Condition groups can be nested at most ${MAX_DEPTH} levels deep`);
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw invalid('Each condition must be an object');
    if ('conditions' in node) {
      if (node.operator !== 'AND' && node.operator !== 'OR') throw invalid('Group operator must be AND or OR');
      if (!Array.isArray(node.conditions) || node.conditions.length === 0) throw invalid('A condition group must contain at least one condition');
      return { operator: node.operator, conditions: node.conditions.map((c: unknown) => walk(c, depth + 1)) };
    }
    leaves++;
    if (leaves > MAX_LEAVES) throw invalid(`A rule can have at most ${MAX_LEAVES} conditions`);
    const def = FIELD_CATALOG[node.field];
    if (!def) throw invalid(`Unsupported field "${String(node.field)}"`);
    if (!OPERATORS.includes(node.operator)) throw invalid(`Unsupported operator "${String(node.operator)}"`);
    if (!def.operators.includes(node.operator)) throw invalid(`Operator "${node.operator}" cannot be used with "${def.label}"`);
    let value = node.value;
    switch (def.type) {
      case 'number': {
        const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
        if (typeof n !== 'number' || !Number.isFinite(n)) throw invalid(`"${def.label}" needs a numeric value`);
        value = n;
        break;
      }
      case 'boolean':
        if (value === 'true') value = true;
        if (value === 'false') value = false;
        if (typeof value !== 'boolean') throw invalid(`"${def.label}" needs true or false`);
        break;
      case 'risk':
        if (typeof value !== 'string' || !RISK_ORDER.includes(value as any)) throw invalid(`"${def.label}" must be one of ${RISK_ORDER.join(', ')}`);
        break;
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`"${def.label}" needs a date in YYYY-MM-DD format`);
        break;
      case 'string':
        if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw invalid(`"${def.label}" needs a text value`);
        break;
    }
    return { field: node.field, operator: node.operator, value };
  };
  return walk(input, 1);
}

export interface LeafTrace {
  type: 'condition';
  field: string;
  label: string;
  operator: Operator;
  expected: string | number | boolean;
  actual: unknown;
  matched: boolean;
}
export interface GroupTrace {
  type: 'group';
  operator: 'AND' | 'OR';
  matched: boolean;
  children: (LeafTrace | GroupTrace)[];
}

function compare(actual: unknown, op: Operator, expected: string | number | boolean, type: string): boolean {
  if (actual === null || actual === undefined) return op === 'not_equals';
  let a: number | string | boolean;
  let b: number | string | boolean = expected;
  switch (type) {
    case 'number':
      a = Number(actual);
      b = Number(expected);
      break;
    case 'date':
      a = actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
      b = Date.parse(String(expected));
      break;
    case 'risk':
      a = RISK_ORDER.indexOf(actual as any);
      b = RISK_ORDER.indexOf(expected as any);
      break;
    case 'boolean':
      a = Boolean(actual);
      break;
    default:
      a = String(actual).toLowerCase();
      b = String(expected).toLowerCase();
  }
  switch (op) {
    case 'equals':
      return a === b;
    case 'not_equals':
      return a !== b;
    case 'greater_than':
      return a > b;
    case 'greater_than_or_equal':
      return a >= b;
    case 'less_than':
      return a < b;
    case 'less_than_or_equal':
      return a <= b;
    case 'contains':
      return String(a).includes(String(b));
  }
}

/** Pure evaluation of a condition tree against a context. Does not short-circuit, so the trace is always complete. */
export function evaluateTree(node: ConditionNode, ctx: RuleContext): GroupTrace | LeafTrace {
  if (isGroup(node)) {
    const children = node.conditions.map((c) => evaluateTree(c, ctx));
    const matched = node.operator === 'AND' ? children.every((c) => c.matched) : children.some((c) => c.matched);
    return { type: 'group', operator: node.operator, matched, children };
  }
  const def = FIELD_CATALOG[node.field];
  const raw = getFieldValue(ctx, node.field);
  const actual = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
  return {
    type: 'condition',
    field: node.field,
    label: def?.label ?? node.field,
    operator: node.operator,
    expected: node.value,
    actual,
    matched: def ? compare(raw, node.operator, node.value, def.type) : false,
  };
}

export function flattenTrace(t: GroupTrace | LeafTrace): LeafTrace[] {
  return t.type === 'condition' ? [t] : t.children.flatMap(flattenTrace);
}

export function describeCondition(node: ConditionNode, top = true): string {
  if (isGroup(node)) {
    const inner = node.conditions.map((c) => describeCondition(c, false)).join(` ${node.operator} `);
    return top || node.conditions.length === 1 ? inner : `(${inner})`;
  }
  const label = FIELD_CATALOG[node.field]?.label ?? node.field;
  return `${label} ${OPERATOR_LABELS[node.operator]} ${String(node.value)}`;
}

export function leafDescriptions(node: ConditionNode): string[] {
  return isGroup(node) ? node.conditions.flatMap(leafDescriptions) : [describeCondition(node)];
}
