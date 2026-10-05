import { RuleAction, ACTION_KIND } from './actions';

export type DispositionKind = 'AUTO_APPROVE' | 'REQUIRE_APPROVAL' | 'MANUAL_REVIEW' | 'REJECT';

export interface Disposition {
  kind: DispositionKind;
  /** Approval chain (levels) for REQUIRE_APPROVAL. */
  levels?: { role?: string; userId?: string }[];
  reason?: string;
}

/** Higher = more restrictive. Used to break ties between rules of EQUAL priority. */
export const SEVERITY: Record<DispositionKind, number> = { AUTO_APPROVE: 1, REQUIRE_APPROVAL: 2, MANUAL_REVIEW: 3, REJECT: 4 };

export function toDisposition(a: RuleAction): Disposition | null {
  switch (a.type) {
    case 'AUTO_APPROVE':
      return { kind: 'AUTO_APPROVE' };
    case 'REQUIRE_APPROVAL':
      return { kind: 'REQUIRE_APPROVAL', levels: [{ role: a.role, userId: a.userId }] };
    case 'REQUIRE_MULTI_LEVEL_APPROVAL':
      return { kind: 'REQUIRE_APPROVAL', levels: a.levels.map((l) => ({ role: l.role, userId: l.userId })) };
    case 'REJECT_INVOICE':
      return { kind: 'REJECT', reason: a.reason };
    case 'MOVE_TO_EXCEPTION_QUEUE':
    case 'REQUEST_HUMAN_REVIEW':
      return { kind: 'MANUAL_REVIEW', reason: a.reason };
    default:
      return null;
  }
}

export interface MatchedRule {
  id: string;
  name: string;
  priority: number;
  createdAt: Date;
  actions: RuleAction[];
}

export interface Candidate {
  ruleId: string;
  ruleName: string;
  priority: number;
  actionIndex: number;
  disposition: Disposition;
}

export interface Resolution {
  winner: Candidate | null;
  /** Decision actions that matched but lost; keyed `${ruleId}:${actionIndex}`. */
  suppressed: Map<string, string>;
}

/**
 * CONFLICT RESOLUTION (documented in README):
 *  1. Matched rules are ordered by priority (1 = highest), then creation time.
 *  2. The winning disposition comes from the highest-priority matched rule that has a decision action.
 *  3. If several decision actions share that priority, the MOST RESTRICTIVE wins: REJECT > MANUAL_REVIEW > REQUIRE_APPROVAL > AUTO_APPROVE.
 *     So an equal-priority restrictive rule always overrides AUTO_APPROVE.
 *  4. Every other decision action is marked "suppressed" (still recorded, never executed).
 *  Side-effect actions (notify, tag, task, ...) from all matched rules still run.
 */
export function resolveDecision(matched: MatchedRule[]): Resolution {
  const candidates: Candidate[] = [];
  const ordered = [...matched].sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  for (const r of ordered) {
    r.actions.forEach((a, i) => {
      if (ACTION_KIND[a.type] !== 'decision') return;
      const d = toDisposition(a);
      if (d) candidates.push({ ruleId: r.id, ruleName: r.name, priority: r.priority, actionIndex: i, disposition: d });
    });
  }
  const suppressed = new Map<string, string>();
  if (!candidates.length) return { winner: null, suppressed };
  const top = Math.min(...candidates.map((c) => c.priority));
  const tier = candidates.filter((c) => c.priority === top);
  const winner = tier.reduce((best, c) => (SEVERITY[c.disposition.kind] > SEVERITY[best.disposition.kind] ? c : best), tier[0]);
  for (const c of candidates) {
    if (c !== winner) {
      suppressed.set(`${c.ruleId}:${c.actionIndex}`, `Overridden by "${winner.ruleName}" (priority ${winner.priority}, ${winner.disposition.kind})`);
    }
  }
  return { winner, suppressed };
}
