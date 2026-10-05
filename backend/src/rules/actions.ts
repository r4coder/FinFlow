import { z } from 'zod';
import { RiskLevel, Role, RuleTrigger } from '@prisma/client';
import { Tx } from '../db';
import { badRequest } from '../utils/errors';
import { DECISION_TRIGGERS } from './fields';
import { notifyUser, renderTemplate, resolveRecipients } from '../notifications/notification.service';

const approverRole = z.enum(['FINANCE_MANAGER', 'ADMIN', 'OWNER']);
const approverRef = z
  .object({ role: approverRole.optional(), userId: z.string().uuid().optional() })
  .refine((a) => a.role || a.userId, 'Choose a role or a specific user');
const recipient = z.enum(['UPLOADER', 'FINANCE_MANAGER', 'ADMIN', 'OWNER', 'USER']);

export const ACTION_SCHEMAS = {
  AUTO_APPROVE: z.object({ type: z.literal('AUTO_APPROVE') }),
  REQUIRE_APPROVAL: z.object({ type: z.literal('REQUIRE_APPROVAL') }).and(approverRef),
  REQUIRE_MULTI_LEVEL_APPROVAL: z.object({ type: z.literal('REQUIRE_MULTI_LEVEL_APPROVAL'), levels: z.array(approverRef).min(2).max(5) }),
  REJECT_INVOICE: z.object({ type: z.literal('REJECT_INVOICE'), reason: z.string().max(300).default('Rejected by automation rule') }),
  SEND_NOTIFICATION: z.object({
    type: z.literal('SEND_NOTIFICATION'),
    recipient,
    userId: z.string().uuid().optional(),
    title: z.string().max(120).optional(),
    message: z.string().max(500).optional(),
  }),
  CREATE_TASK: z.object({
    type: z.literal('CREATE_TASK'),
    title: z.string().min(1).max(200),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
    assignTo: recipient,
    userId: z.string().uuid().optional(),
    dueInDays: z.coerce.number().int().min(0).max(90).default(2),
  }),
  ADD_TAG: z.object({ type: z.literal('ADD_TAG'), tag: z.string().trim().min(1).max(50) }),
  MOVE_TO_EXCEPTION_QUEUE: z.object({ type: z.literal('MOVE_TO_EXCEPTION_QUEUE'), reason: z.string().max(300).optional() }),
  SET_RISK_LEVEL: z.object({ type: z.literal('SET_RISK_LEVEL'), level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) }),
  UPDATE_STATUS: z.object({ type: z.literal('UPDATE_STATUS'), status: z.enum(['MANUAL_REVIEW', 'PAID']) }),
  REQUEST_HUMAN_REVIEW: z.object({ type: z.literal('REQUEST_HUMAN_REVIEW'), reason: z.string().max(300).optional() }),
  TRIGGER_AI_ANALYSIS: z.object({ type: z.literal('TRIGGER_AI_ANALYSIS') }),
} as const;

export type ActionType = keyof typeof ACTION_SCHEMAS;
export type RuleAction = z.infer<(typeof ACTION_SCHEMAS)[ActionType]>;

/** decision = determines the invoice's disposition (resolved by priority); effect = side effect that always runs. */
export const ACTION_KIND: Record<ActionType, 'decision' | 'effect'> = {
  AUTO_APPROVE: 'decision',
  REQUIRE_APPROVAL: 'decision',
  REQUIRE_MULTI_LEVEL_APPROVAL: 'decision',
  REJECT_INVOICE: 'decision',
  MOVE_TO_EXCEPTION_QUEUE: 'decision',
  REQUEST_HUMAN_REVIEW: 'decision',
  SEND_NOTIFICATION: 'effect',
  CREATE_TASK: 'effect',
  ADD_TAG: 'effect',
  SET_RISK_LEVEL: 'effect',
  UPDATE_STATUS: 'effect',
  TRIGGER_AI_ANALYSIS: 'effect',
};

export const ACTION_LABELS: Record<ActionType, string> = {
  AUTO_APPROVE: 'Auto-approve invoice',
  REQUIRE_APPROVAL: 'Require approval',
  REQUIRE_MULTI_LEVEL_APPROVAL: 'Require multi-level approval',
  REJECT_INVOICE: 'Reject invoice',
  SEND_NOTIFICATION: 'Send notification',
  CREATE_TASK: 'Create task',
  ADD_TAG: 'Add tag',
  MOVE_TO_EXCEPTION_QUEUE: 'Move to exception queue',
  SET_RISK_LEVEL: 'Set risk level',
  UPDATE_STATUS: 'Update status',
  REQUEST_HUMAN_REVIEW: 'Request human review',
  TRIGGER_AI_ANALYSIS: 'Trigger AI analysis',
};

const roleName = (r?: string) => (r ? r.replace('_', ' ').toLowerCase() : 'specific user');

export function describeAction(a: RuleAction): string {
  switch (a.type) {
    case 'AUTO_APPROVE':
      return 'Auto-approve the invoice';
    case 'REQUIRE_APPROVAL':
      return `Require ${a.role ? roleName(a.role) : 'specific user'} approval`;
    case 'REQUIRE_MULTI_LEVEL_APPROVAL':
      return `Require ${a.levels.length}-level approval (${a.levels.map((l) => roleName(l.role)).join(' → ')})`;
    case 'REJECT_INVOICE':
      return 'Reject the invoice';
    case 'SEND_NOTIFICATION':
      return `Notify ${a.recipient === 'USER' ? 'specific user' : roleName(a.recipient)}`;
    case 'CREATE_TASK':
      return `Create ${a.priority.toLowerCase()}-priority task "${a.title}" for ${roleName(a.assignTo)}`;
    case 'ADD_TAG':
      return `Add tag "${a.tag}"`;
    case 'MOVE_TO_EXCEPTION_QUEUE':
      return 'Move to exception queue';
    case 'SET_RISK_LEVEL':
      return `Set risk level to ${a.level}`;
    case 'UPDATE_STATUS':
      return `Set status to ${a.status}`;
    case 'REQUEST_HUMAN_REVIEW':
      return 'Request human review';
    case 'TRIGGER_AI_ANALYSIS':
      return 'Re-run AI risk analysis';
  }
}

/** Validates actions for a rule. Decision actions are only allowed on triggers that run before the disposition is decided. */
export function validateActions(input: unknown, trigger: RuleTrigger): RuleAction[] {
  if (!Array.isArray(input) || input.length === 0) throw badRequest('A rule needs at least one action', 'INVALID_RULE');
  if (input.length > 20) throw badRequest('A rule can have at most 20 actions', 'INVALID_RULE');
  return input.map((raw, i) => {
    const type = (raw as { type?: string })?.type as ActionType;
    const schema = ACTION_SCHEMAS[type];
    if (!schema) throw badRequest(`Action ${i + 1}: unsupported action type "${String(type)}"`, 'INVALID_RULE');
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw badRequest(`Action ${i + 1} (${type}): ${parsed.error.issues.map((x) => x.message).join('; ')}`, 'INVALID_RULE');
    const action = parsed.data as RuleAction;
    if (ACTION_KIND[type] === 'decision' && !DECISION_TRIGGERS.includes(trigger)) {
      throw badRequest(
        `"${ACTION_LABELS[type]}" can only be used with triggers that run before a decision is made (${DECISION_TRIGGERS.join(', ')})`,
        'INVALID_RULE',
      );
    }
    if (action.type === 'SEND_NOTIFICATION' && action.recipient === 'USER' && !action.userId) throw badRequest(`Action ${i + 1}: choose the user to notify`, 'INVALID_RULE');
    if (action.type === 'CREATE_TASK' && action.assignTo === 'USER' && !action.userId) throw badRequest(`Action ${i + 1}: choose the user to assign`, 'INVALID_RULE');
    return action;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Effect execution (side-effect actions). All run inside the caller's transaction and are idempotent.
// ---------------------------------------------------------------------------------------------------------------------

export interface ExecCtx {
  tx: Tx;
  organizationId: string;
  invoice: { id: string; invoiceNumber: string | null; total: number | null; currency: string | null; uploadedBy: string | null; status: string; dueDate: Date | null; riskLevel: RiskLevel | null };
  vendorName: string | null;
  rule: { id: string; name: string };
  runKey: string;
  actionIndex: number;
  deferred: { type: 'AI_ANALYSIS' }[];
}

export function templateVars(c: Pick<ExecCtx, 'invoice' | 'vendorName' | 'rule'>) {
  const total = c.invoice.total;
  return {
    invoiceNumber: c.invoice.invoiceNumber ?? '(no number)',
    vendorName: c.vendorName ?? 'Unknown vendor',
    total: total === null ? 'N/A' : `${c.invoice.currency ?? ''} ${total.toLocaleString('en-IN')}`.trim(),
    currency: c.invoice.currency ?? '',
    riskLevel: c.invoice.riskLevel ?? 'UNKNOWN',
    ruleName: c.rule.name,
    dueDate: c.invoice.dueDate ? c.invoice.dueDate.toISOString().slice(0, 10) : '',
  };
}

export interface EffectResult {
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  detail: string;
}

export async function executeEffect(a: RuleAction, x: ExecCtx): Promise<EffectResult> {
  const dedupe = `rule:${x.rule.id}:${x.invoice.id}:${x.runKey}:${x.actionIndex}`;
  switch (a.type) {
    case 'SEND_NOTIFICATION': {
      const ids = await resolveRecipients(x.organizationId, a.recipient, { uploaderId: x.invoice.uploadedBy, userId: a.userId }, x.tx);
      if (!ids.length) return { status: 'SKIPPED', detail: 'No recipients found' };
      const vars = templateVars(x);
      const message = renderTemplate(a.message ?? 'Business rule "{{ruleName}}" was triggered for invoice {{invoiceNumber}} ({{vendorName}}, {{total}}).', vars);
      const title = renderTemplate(a.title ?? 'Rule triggered: {{ruleName}}', vars);
      let created = 0;
      for (const userId of ids) {
        if (await notifyUser({ organizationId: x.organizationId, userId, type: 'RULE', title, message, invoiceId: x.invoice.id, dedupeKey: dedupe }, x.tx)) created++;
      }
      return { status: 'SUCCESS', detail: `Notified ${ids.length} user(s)${created < ids.length ? ' (already notified)' : ''}` };
    }
    case 'CREATE_TASK': {
      const vars = templateVars(x);
      const title = renderTemplate(a.title, vars);
      let assigneeId: string | null = null;
      let assigneeRole: Role | null = null;
      if (a.assignTo === 'UPLOADER') assigneeId = x.invoice.uploadedBy;
      else if (a.assignTo === 'USER') {
        const ok = a.userId ? await x.tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: x.organizationId, userId: a.userId } } }) : null;
        if (!ok) return { status: 'FAILED', detail: 'Assignee is not a member of this organization' };
        assigneeId = a.userId!;
      } else assigneeRole = a.assignTo as Role;
      const res = await x.tx.task.createMany({
        data: [
          {
            organizationId: x.organizationId,
            invoiceId: x.invoice.id,
            title,
            priority: a.priority,
            assigneeId,
            assigneeRole,
            dueAt: new Date(Date.now() + a.dueInDays * 86400000),
            ruleId: x.rule.id,
            dedupeKey: dedupe,
          },
        ],
        skipDuplicates: true,
      });
      return { status: 'SUCCESS', detail: res.count ? `Task "${title}" created` : 'Task already exists' };
    }
    case 'ADD_TAG': {
      const tag = await x.tx.tag.upsert({
        where: { organizationId_name: { organizationId: x.organizationId, name: a.tag } },
        create: { organizationId: x.organizationId, name: a.tag },
        update: {},
      });
      await x.tx.invoiceTag.createMany({ data: [{ invoiceId: x.invoice.id, tagId: tag.id, ruleId: x.rule.id }], skipDuplicates: true });
      return { status: 'SUCCESS', detail: `Tag "${a.tag}" applied` };
    }
    case 'SET_RISK_LEVEL': {
      await x.tx.invoice.update({ where: { id: x.invoice.id }, data: { riskLevel: a.level } });
      x.invoice.riskLevel = a.level;
      return { status: 'SUCCESS', detail: `Risk level set to ${a.level}` };
    }
    case 'UPDATE_STATUS': {
      const cur = await x.tx.invoice.findUnique({ where: { id: x.invoice.id }, select: { status: true } });
      if (!cur) return { status: 'FAILED', detail: 'Invoice not found' };
      if (a.status === 'PAID' && cur.status !== 'APPROVED') return { status: 'FAILED', detail: `Cannot mark as PAID from ${cur.status} (must be APPROVED)` };
      if (a.status === 'MANUAL_REVIEW' && ['APPROVED', 'REJECTED', 'PAID'].includes(cur.status)) return { status: 'FAILED', detail: `Cannot move a ${cur.status} invoice to MANUAL_REVIEW` };
      await x.tx.invoice.update({ where: { id: x.invoice.id }, data: { status: a.status } });
      return { status: 'SUCCESS', detail: `Status set to ${a.status}` };
    }
    case 'TRIGGER_AI_ANALYSIS':
      x.deferred.push({ type: 'AI_ANALYSIS' });
      return { status: 'SUCCESS', detail: 'AI analysis queued after commit' };
    default:
      return { status: 'SKIPPED', detail: 'Decision action handled by the decision resolver' };
  }
}
