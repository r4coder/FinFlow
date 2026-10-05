import { Prisma, RuleTrigger } from '@prisma/client';
import { z } from 'zod';
import { prisma, Tx } from '../db';
import { audit } from '../services/audit.service';
import { badRequest, notFound } from '../utils/errors';
import { ACTION_KIND, ACTION_LABELS, ACTION_SCHEMAS, RuleAction, describeAction, validateActions } from './actions';
import { ConditionNode, describeCondition, flattenTrace, leafDescriptions, validateConditionTree } from './conditions';
import { buildContext, evaluateRules } from './engine';
import { FIELD_CATALOG, OPERATOR_LABELS, TRIGGER_LABELS, DECISION_TRIGGERS } from './fields';
import { MatchedRule, resolveDecision } from './resolve';
import { RULE_TEMPLATES } from './templates';

export const RuleInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().max(500).nullish(),
  enabled: z.boolean().default(true),
  priority: z.coerce.number().int().min(1).max(10000).default(100),
  trigger: z.nativeEnum(RuleTrigger),
  conditions: z.unknown(),
  actions: z.unknown(),
  templateKey: z.string().max(80).nullish(),
});
export type RuleInput = z.infer<typeof RuleInputSchema>;

interface Actor {
  userId: string;
  fullName: string;
}

/** Validates a rule definition (structure, fields, operators, actions) and that referenced users belong to the org. */
export async function validateRuleDefinition(organizationId: string, input: { trigger: RuleTrigger; conditions: unknown; actions: unknown }, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const conditions = validateConditionTree(input.conditions);
  const actions = validateActions(input.actions, input.trigger);
  const userIds = new Set<string>();
  for (const a of actions) {
    if ('userId' in a && a.userId) userIds.add(a.userId);
    if (a.type === 'REQUIRE_MULTI_LEVEL_APPROVAL') a.levels.forEach((l) => l.userId && userIds.add(l.userId));
  }
  if (userIds.size) {
    const found = await db.organizationMember.count({ where: { organizationId, userId: { in: [...userIds] } } });
    if (found !== userIds.size) throw badRequest('A referenced user does not belong to this organization', 'INVALID_RULE');
  }
  return { conditions, actions };
}

export const snapshotOf = (r: { name: string; description: string | null; enabled: boolean; priority: number; trigger: RuleTrigger; conditions: unknown; actions: unknown }) => ({
  name: r.name,
  description: r.description,
  enabled: r.enabled,
  priority: r.priority,
  trigger: r.trigger,
  conditions: r.conditions,
  actions: r.actions,
});

/** Human-readable diff between two rule snapshots, e.g. "Condition changed: Invoice total is greater than 50000 → …". */
export function diffSnapshots(a: ReturnType<typeof snapshotOf> | null, b: ReturnType<typeof snapshotOf>): string {
  if (!a) return 'Rule created';
  const out: string[] = [];
  if (a.name !== b.name) out.push(`Name: "${a.name}" → "${b.name}"`);
  if ((a.description ?? '') !== (b.description ?? '')) out.push('Description changed');
  if (a.enabled !== b.enabled) out.push(b.enabled ? 'Rule enabled' : 'Rule disabled');
  if (a.priority !== b.priority) out.push(`Priority: ${a.priority} → ${b.priority}`);
  if (a.trigger !== b.trigger) out.push(`Trigger: ${TRIGGER_LABELS[a.trigger]} → ${TRIGGER_LABELS[b.trigger]}`);
  const setDiff = (x: string[], y: string[], word: string) => {
    const removed = x.filter((v) => !y.includes(v));
    const added = y.filter((v) => !x.includes(v));
    if (removed.length && removed.length === added.length) removed.forEach((r, i) => out.push(`${word} changed: ${r} → ${added[i]}`));
    else {
      removed.forEach((r) => out.push(`${word} removed: ${r}`));
      added.forEach((r) => out.push(`${word} added: ${r}`));
    }
  };
  try {
    setDiff(leafDescriptions(a.conditions as ConditionNode), leafDescriptions(b.conditions as ConditionNode), 'Condition');
    if ((a.conditions as any)?.operator !== (b.conditions as any)?.operator) out.push(`Match mode: ${(a.conditions as any)?.operator} → ${(b.conditions as any)?.operator}`);
  } catch {
    out.push('Conditions changed');
  }
  try {
    setDiff((a.actions as RuleAction[]).map(describeAction), (b.actions as RuleAction[]).map(describeAction), 'Action');
  } catch {
    out.push('Actions changed');
  }
  return out.length ? out.join('; ') : 'No functional change';
}

export function presentRule(r: any, stats?: { executions: number; lastExecutionAt: Date | null }) {
  let conditionsSummary = '';
  let actionsSummary: string[] = [];
  try {
    conditionsSummary = describeCondition(r.conditions as ConditionNode);
    actionsSummary = (r.actions as RuleAction[]).map(describeAction);
  } catch {
    conditionsSummary = 'Invalid rule definition';
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    priority: r.priority,
    trigger: r.trigger,
    triggerLabel: TRIGGER_LABELS[r.trigger as RuleTrigger],
    conditions: r.conditions,
    actions: r.actions,
    version: r.version,
    templateKey: r.templateKey,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    conditionsSummary,
    actionsSummary,
    executionCount: stats?.executions ?? 0,
    lastExecutionAt: stats?.lastExecutionAt ?? null,
  };
}

export async function createRule(organizationId: string, actor: Actor, input: RuleInput, db: Tx | typeof prisma = prisma) {
  const { conditions, actions } = await validateRuleDefinition(organizationId, { trigger: input.trigger, conditions: input.conditions, actions: input.actions }, db);
  const rule = await db.businessRule.create({
    data: {
      organizationId,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled,
      priority: input.priority,
      trigger: input.trigger,
      conditions: conditions as any,
      actions: actions as any,
      templateKey: input.templateKey ?? null,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    },
  });
  await db.businessRuleVersion.create({
    data: { ruleId: rule.id, organizationId, version: 1, snapshot: snapshotOf(rule) as any, changeSummary: 'Rule created', changedBy: actor.userId, changedByName: actor.fullName },
  });
  await audit({ organizationId, action: 'rule.created', entityType: 'rule', entityId: rule.id, userId: actor.userId, userName: actor.fullName, metadata: { name: rule.name, priority: rule.priority, trigger: rule.trigger } }, db);
  return rule;
}

export async function updateRule(organizationId: string, ruleId: string, actor: Actor, patch: Partial<RuleInput>) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.businessRule.findFirst({ where: { id: ruleId, organizationId, deletedAt: null } });
    if (!current) throw notFound('Rule not found');
    const merged = {
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description ?? null,
      enabled: patch.enabled ?? current.enabled,
      priority: patch.priority ?? current.priority,
      trigger: patch.trigger ?? current.trigger,
      conditions: patch.conditions === undefined ? current.conditions : patch.conditions,
      actions: patch.actions === undefined ? current.actions : patch.actions,
    };
    const { conditions, actions } = await validateRuleDefinition(organizationId, merged, tx);
    const before = snapshotOf(current);
    const after = snapshotOf({ ...merged, conditions, actions });
    const summary = diffSnapshots(before, after);
    if (summary === 'No functional change') return current;
    const version = current.version + 1;
    const updated = await tx.businessRule.update({
      where: { id: ruleId },
      data: { ...merged, conditions: conditions as any, actions: actions as any, version, updatedBy: actor.userId },
    });
    await tx.businessRuleVersion.create({
      data: { ruleId, organizationId, version, snapshot: after as any, changeSummary: summary, changedBy: actor.userId, changedByName: actor.fullName },
    });
    await audit({ organizationId, action: 'rule.modified', entityType: 'rule', entityId: ruleId, userId: actor.userId, userName: actor.fullName, metadata: { name: updated.name, version, change: summary } }, tx);
    return updated;
  });
}

/** Soft delete: the rule disappears from the UI and engine, but its versions and executions remain for audit. */
export async function deleteRule(organizationId: string, ruleId: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const current = await tx.businessRule.findFirst({ where: { id: ruleId, organizationId, deletedAt: null } });
    if (!current) throw notFound('Rule not found');
    const version = current.version + 1;
    await tx.businessRule.update({ where: { id: ruleId }, data: { deletedAt: new Date(), enabled: false, version, updatedBy: actor.userId } });
    await tx.businessRuleVersion.create({
      data: { ruleId, organizationId, version, snapshot: snapshotOf({ ...current, enabled: false }) as any, changeSummary: 'Rule deleted', changedBy: actor.userId, changedByName: actor.fullName },
    });
    await audit({ organizationId, action: 'rule.deleted', entityType: 'rule', entityId: ruleId, userId: actor.userId, userName: actor.fullName, metadata: { name: current.name } }, tx);
  });
}

export async function duplicateRule(organizationId: string, ruleId: string, actor: Actor) {
  const src = await prisma.businessRule.findFirst({ where: { id: ruleId, organizationId, deletedAt: null } });
  if (!src) throw notFound('Rule not found');
  return createRule(organizationId, actor, {
    name: `${src.name} (copy)`.slice(0, 120),
    description: src.description,
    enabled: false, // copies start disabled so they cannot silently change behaviour
    priority: src.priority,
    trigger: src.trigger,
    conditions: src.conditions,
    actions: src.actions,
    templateKey: src.templateKey,
  });
}

export async function seedDefaultRules(organizationId: string, actor: Actor, tx: Tx) {
  for (const t of RULE_TEMPLATES.filter((x) => x.isDefault)) {
    await createRule(organizationId, actor, { name: t.name, description: t.description, enabled: true, priority: t.priority, trigger: t.trigger, conditions: t.conditions, actions: t.actions, templateKey: t.key }, tx);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dry run: evaluates a rule (saved or draft) against an existing invoice. NEVER writes anything.
// ---------------------------------------------------------------------------------------------------------------------

export async function dryRun(
  organizationId: string,
  invoiceId: string,
  rule: { id?: string; name: string; priority: number; trigger: RuleTrigger; conditions: unknown; actions: unknown },
) {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, organizationId }, include: { vendor: true } });
  if (!invoice) throw notFound('Invoice not found');
  const { conditions, actions } = await validateRuleDefinition(organizationId, rule);
  const ctx = buildContext(invoice);
  const draft = { id: rule.id ?? 'draft', name: rule.name, priority: rule.priority, version: 0, trigger: rule.trigger, createdAt: new Date(), conditions, actions };
  const [ev] = evaluateRules([draft], ctx);
  const leaves = ev.trace ? flattenTrace(ev.trace) : [];

  // Simulated outcome if this rule (with its draft definition) were active alongside the org's other enabled rules.
  let decisionPreview: { disposition: string; decidedBy: string } | null = null;
  if (DECISION_TRIGGERS.includes(rule.trigger)) {
    const others = await prisma.businessRule.findMany({
      where: { organizationId, enabled: true, deletedAt: null, trigger: { in: DECISION_TRIGGERS }, ...(rule.id ? { id: { not: rule.id } } : {}) },
    });
    const evals = evaluateRules([...others, draft], ctx).filter((e) => e.matched);
    const res = resolveDecision(evals.map((e): MatchedRule => ({ id: e.rule.id, name: e.rule.name, priority: e.rule.priority, createdAt: e.rule.createdAt, actions: e.actions })));
    decisionPreview = res.winner ? { disposition: res.winner.disposition.kind, decidedBy: res.winner.ruleName } : null;
  }

  return {
    dryRun: true,
    matched: ev.matched,
    invoice: { id: invoice.id, invoiceNumber: invoice.invoiceNumber, total: invoice.total ? Number(invoice.total) : null, currency: invoice.currency, riskLevel: invoice.riskLevel, vendor: invoice.vendor?.name ?? null },
    conditions: leaves.map((l) => ({ field: l.field, label: l.label, operator: l.operator, operatorLabel: OPERATOR_LABELS[l.operator], expected: l.expected, actual: l.actual, matched: l.matched })),
    trace: ev.trace,
    actions: ev.matched ? ev.actions.map((a) => a.type) : [],
    actionDetails: ev.matched ? ev.actions.map((a) => ({ type: a.type, label: ACTION_LABELS[a.type], description: describeAction(a), kind: ACTION_KIND[a.type] })) : [],
    decisionPreview,
    note: 'Dry run only — no actions were executed and nothing was changed.',
  };
}

/** Everything the rule-builder UI needs: fields, operators, triggers, action types. Single source of truth = backend. */
export function builderMetadata() {
  return {
    fields: Object.entries(FIELD_CATALOG).map(([key, f]) => ({
      key,
      label: f.label,
      type: f.type,
      group: f.group,
      operators: f.operators.map((o) => ({ key: o, label: OPERATOR_LABELS[o] })),
      options: f.options ?? null,
      help: f.help ?? null,
    })),
    triggers: (Object.keys(TRIGGER_LABELS) as RuleTrigger[]).map((t) => ({ key: t, label: TRIGGER_LABELS[t], allowsDecisionActions: DECISION_TRIGGERS.includes(t) })),
    actions: (Object.keys(ACTION_SCHEMAS) as (keyof typeof ACTION_SCHEMAS)[]).map((a) => ({ type: a, label: ACTION_LABELS[a], kind: ACTION_KIND[a] })),
  };
}
