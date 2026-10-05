import { Prisma, RuleTrigger } from '@prisma/client';
import { Tx } from '../db';
import { audit } from '../services/audit.service';
import { num, round2 } from '../utils/money';
import { applyDisposition, DecisionOutcome } from '../automation/decision';
import { ACTION_KIND, ACTION_LABELS, ExecCtx, RuleAction, describeAction, executeEffect, validateActions } from './actions';
import { ConditionNode, evaluateTree, GroupTrace, LeafTrace, validateConditionTree } from './conditions';
import { DECISION_TRIGGERS, RuleContext } from './fields';
import { Disposition, MatchedRule, resolveDecision, SEVERITY } from './resolve';

/** Maximum chained-event depth (e.g. INVOICE_PROCESSED -> INVOICE_APPROVED -> ...). Prevents rule loops. */
export const MAX_EVENT_DEPTH = 3;

type InvoiceWithVendor = Prisma.InvoiceGetPayload<{ include: { vendor: true } }>;

export function buildContext(inv: InvoiceWithVendor): RuleContext {
  const subtotal = num(inv.subtotal);
  const tax = num(inv.tax);
  return {
    invoice: {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      total: num(inv.total),
      subtotal,
      tax,
      taxRate: subtotal && tax !== null ? round2((tax / subtotal) * 100) : null,
      currency: inv.currency,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      riskLevel: inv.riskLevel,
      purchaseOrderPresent: Boolean(inv.purchaseOrderNumber),
      duplicateDetected: inv.duplicateDetected,
      aiConfidence: inv.aiConfidence === null ? null : Math.round(inv.aiConfidence * 1000) / 10,
      uploadedBy: inv.uploadedBy,
    },
    vendor: inv.vendor ? { id: inv.vendor.id, name: inv.vendor.name, industry: inv.vendor.industry, group: inv.vendor.group } : null,
  };
}

export interface ActionRecord {
  type: string;
  label: string;
  description: string;
  kind: 'decision' | 'effect';
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'SUPPRESSED';
  detail: string;
}

export interface RuleEvaluation {
  rule: { id: string; name: string; priority: number; version: number; trigger: RuleTrigger; createdAt: Date };
  matched: boolean;
  trace: GroupTrace | LeafTrace | null;
  actions: RuleAction[];
  error?: string;
}

/** PURE: evaluates rules against a context (no database writes). Shared by real execution and dry-run. */
export function evaluateRules(
  rules: { id: string; name: string; priority: number; version: number; trigger: RuleTrigger; createdAt: Date; conditions: unknown; actions: unknown }[],
  ctx: RuleContext,
): RuleEvaluation[] {
  return rules.map((r) => {
    const base = { id: r.id, name: r.name, priority: r.priority, version: r.version, trigger: r.trigger, createdAt: r.createdAt };
    try {
      const tree: ConditionNode = validateConditionTree(r.conditions);
      const actions = validateActions(r.actions, r.trigger);
      const trace = evaluateTree(tree, ctx);
      return { rule: base, matched: trace.matched, trace, actions };
    } catch (e) {
      return { rule: base, matched: false, trace: null, actions: [], error: `Invalid stored rule: ${(e as Error).message}` };
    }
  });
}

export interface SafetyFloor {
  /** Findings that must prevent automatic approval and force at least manual review (duplicates, arithmetic failures...). */
  blocking: string[];
  exceptionReasons: string[];
}

export interface EngineInput {
  tx: Tx;
  organizationId: string;
  invoiceId: string;
  triggers: RuleTrigger[];
  /** Identifies this logical run; combined with depth/trigger it forms the idempotency key of each execution. */
  runKey: string;
  depth?: number;
  safety?: SafetyFloor;
  actorUserId?: string | null;
}

export interface EngineOutcome {
  evaluations: RuleEvaluation[];
  applied: DecisionOutcome | null;
  decisionSource: string | null;
  systemOverride: string | null;
  deferred: { type: 'AI_ANALYSIS' }[];
  skipped: string[];
}

export async function runEvent(input: EngineInput): Promise<EngineOutcome> {
  const { tx, organizationId, invoiceId, triggers, runKey } = input;
  const depth = input.depth ?? 0;
  const outcome: EngineOutcome = { evaluations: [], applied: null, decisionSource: null, systemOverride: null, deferred: [], skipped: [] };

  if (depth > MAX_EVENT_DEPTH) {
    await audit({ organizationId, action: 'rule.loop_prevented', entityType: 'invoice', entityId: invoiceId, invoiceId, metadata: { triggers, depth } }, tx);
    return outcome;
  }

  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, organizationId }, include: { vendor: true } });
  if (!inv) return outcome;
  const ctx = buildContext(inv);

  const rules = await tx.businessRule.findMany({
    where: { organizationId, enabled: true, deletedAt: null, trigger: { in: triggers } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
  const evalKey = (trigger: string) => `${runKey}:d${depth}:${trigger}`;
  const existing = new Set(
    (
      await tx.businessRuleExecution.findMany({
        where: { invoiceId, ruleId: { in: rules.map((r) => r.id) }, runKey: { in: triggers.map(evalKey) } },
        select: { ruleId: true, trigger: true },
      })
    ).map((e) => `${e.ruleId}:${e.trigger}`),
  );

  const startedAt = new Date();
  const runnable = rules.filter((r) => {
    const dup = existing.has(`${r.id}:${r.trigger}`);
    if (dup) outcome.skipped.push(r.id); // already executed for this event -> never run twice
    return !dup;
  });
  const evaluations = evaluateRules(runnable, ctx);
  outcome.evaluations = evaluations;
  const matched = evaluations.filter((e) => e.matched);

  const isDecisionRun = triggers.every((t) => DECISION_TRIGGERS.includes(t));
  const matchedRules: MatchedRule[] = matched.map((m) => ({ id: m.rule.id, name: m.rule.name, priority: m.rule.priority, createdAt: m.rule.createdAt, actions: m.actions }));
  const resolution = isDecisionRun ? resolveDecision(matchedRules) : { winner: null, suppressed: new Map<string, string>() };

  // ---- decision (with the system safety floor) ----
  let disposition: Disposition | null = resolution.winner?.disposition ?? null;
  let decisionRule: { id: string | null; name: string } | null = resolution.winner ? { id: resolution.winner.ruleId, name: resolution.winner.ruleName } : null;
  const overridden = new Set<string>();
  if (isDecisionRun) {
    const blocking = input.safety?.blocking ?? [];
    if (blocking.length && (!disposition || SEVERITY[disposition.kind] < SEVERITY.MANUAL_REVIEW)) {
      const was = disposition ? `${disposition.kind} (rule "${decisionRule?.name}")` : 'no matching rule';
      outcome.systemOverride = `System safety floor: ${blocking.join('; ')} — forced manual review instead of ${was}`;
      if (resolution.winner) overridden.add(`${resolution.winner.ruleId}:${resolution.winner.actionIndex}`);
      disposition = { kind: 'MANUAL_REVIEW', reason: blocking.join('; ') };
      decisionRule = { id: null, name: 'System safety floor' };
    } else if (!disposition) {
      outcome.systemOverride = 'No rule decided this invoice — routed to a finance manager (safe default, never auto-approved)';
      disposition = { kind: 'REQUIRE_APPROVAL', levels: [{ role: 'FINANCE_MANAGER' }] };
      decisionRule = { id: null, name: 'Default routing' };
    }
    outcome.decisionSource = decisionRule?.name ?? null;
    outcome.applied = await applyDisposition({
      tx,
      organizationId,
      invoice: { id: inv.id, invoiceNumber: inv.invoiceNumber, uploadedBy: inv.uploadedBy },
      disposition,
      ruleId: decisionRule?.id ?? null,
      ruleName: decisionRule?.name ?? 'System',
      runKey: evalKey('decision'),
      exceptionReasons: input.safety?.exceptionReasons ?? [],
    });
  }

  // ---- effects + execution records ----
  const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const execInvoice: ExecCtx['invoice'] = {
    id: fresh.id,
    invoiceNumber: fresh.invoiceNumber,
    total: num(fresh.total),
    currency: fresh.currency,
    uploadedBy: fresh.uploadedBy,
    status: fresh.status,
    dueDate: fresh.dueDate,
    riskLevel: fresh.riskLevel,
  };

  for (const ev of evaluations) {
    const t0 = Date.now();
    const records: ActionRecord[] = [];
    if (ev.matched) {
      for (let i = 0; i < ev.actions.length; i++) {
        const a = ev.actions[i];
        const kind = ACTION_KIND[a.type];
        const base = { type: a.type, label: ACTION_LABELS[a.type], description: describeAction(a), kind };
        if (kind === 'decision') {
          const key = `${ev.rule.id}:${i}`;
          const won = resolution.winner && resolution.winner.ruleId === ev.rule.id && resolution.winner.actionIndex === i;
          if (overridden.has(key)) records.push({ ...base, status: 'SUPPRESSED', detail: outcome.systemOverride ?? 'Overridden by system safety floor' });
          else if (won) records.push({ ...base, status: 'SUCCESS', detail: outcome.applied?.note ?? 'Applied' });
          else records.push({ ...base, status: 'SUPPRESSED', detail: resolution.suppressed.get(key) ?? 'Not applied' });
          continue;
        }
        try {
          const res = await executeEffect(a, {
            tx,
            organizationId,
            invoice: execInvoice,
            vendorName: inv.vendor?.name ?? null,
            rule: { id: ev.rule.id, name: ev.rule.name },
            runKey: evalKey(ev.rule.trigger),
            actionIndex: i,
            deferred: outcome.deferred,
          });
          records.push({ ...base, status: res.status, detail: res.detail });
        } catch (e) {
          // A failing effect is recorded, never pretended to have succeeded. (Savepoint-free: effects only do idempotent upserts.)
          records.push({ ...base, status: 'FAILED', detail: (e as Error).message });
        }
      }
    }
    const failed = records.filter((r) => r.status === 'FAILED').length;
    const succeeded = records.filter((r) => r.status === 'SUCCESS').length;
    const result = !ev.matched ? 'NOT_MATCHED' : failed === 0 ? 'SUCCESS' : succeeded > 0 ? 'PARTIAL_FAILURE' : 'FAILED';
    const completedAt = new Date();
    await tx.businessRuleExecution.createMany({
      data: [
        {
          organizationId,
          ruleId: ev.rule.id,
          ruleVersion: ev.rule.version,
          ruleName: ev.rule.name,
          invoiceId,
          trigger: ev.rule.trigger,
          runKey: evalKey(ev.rule.trigger),
          depth,
          conditionsEvaluated: (ev.trace ?? {}) as any,
          matched: ev.matched,
          actionsExecuted: records as any,
          result,
          error: ev.error ?? (failed ? records.filter((r) => r.status === 'FAILED').map((r) => r.detail).join('; ') : null),
          startedAt: new Date(startedAt.getTime()),
          completedAt,
          durationMs: Math.max(1, completedAt.getTime() - t0),
        },
      ],
      skipDuplicates: true,
    });
    if (ev.matched) {
      await audit(
        { organizationId, action: 'rule.matched', entityType: 'rule', entityId: ev.rule.id, invoiceId, metadata: { rule: ev.rule.name, trigger: ev.rule.trigger, result, actions: records.map((r) => `${r.type}:${r.status}`) } },
        tx,
      );
    }
  }

  // ---- chained events (depth-limited) ----
  if (outcome.applied) {
    for (const evt of outcome.applied.events) {
      const nextTriggers: RuleTrigger[] = evt === 'APPROVAL_REQUESTED' ? ['APPROVAL_REQUESTED'] : [evt];
      await runEvent({ tx, organizationId, invoiceId, triggers: nextTriggers, runKey, depth: depth + 1, actorUserId: input.actorUserId });
    }
  }
  return outcome;
}
