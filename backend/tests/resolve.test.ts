import { describe, expect, it } from 'vitest';
import { resolveDecision, MatchedRule } from '../src/rules/resolve';

const rule = (id: string, priority: number, actions: any[], createdAt = new Date(2026, 0, priority)): MatchedRule => ({ id, name: id, priority, createdAt, actions });

describe('conflict resolution', () => {
  it('higher priority (lower number) wins', () => {
    const r = resolveDecision([rule('auto', 5, [{ type: 'AUTO_APPROVE' }]), rule('mgr', 2, [{ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' }])]);
    expect(r.winner?.ruleId).toBe('mgr');
    expect(r.suppressed.get('auto:0')).toMatch(/Overridden by "mgr"/);
  });
  it('at EQUAL priority the most restrictive action wins over AUTO_APPROVE', () => {
    const r = resolveDecision([rule('auto', 3, [{ type: 'AUTO_APPROVE' }]), rule('review', 3, [{ type: 'REQUEST_HUMAN_REVIEW' }])]);
    expect(r.winner?.disposition.kind).toBe('MANUAL_REVIEW');
    const r2 = resolveDecision([rule('review', 3, [{ type: 'REQUEST_HUMAN_REVIEW' }]), rule('rej', 3, [{ type: 'REJECT_INVOICE', reason: 'x' }])]);
    expect(r2.winner?.disposition.kind).toBe('REJECT');
  });
  it('a LOWER-priority restrictive rule does not override a higher-priority auto-approve (documented behaviour)', () => {
    const r = resolveDecision([rule('auto', 1, [{ type: 'AUTO_APPROVE' }]), rule('review', 9, [{ type: 'REQUEST_HUMAN_REVIEW' }])]);
    expect(r.winner?.disposition.kind).toBe('AUTO_APPROVE');
  });
  it('no decision actions => no winner; effects never conflict', () => {
    const r = resolveDecision([rule('n', 1, [{ type: 'SEND_NOTIFICATION', recipient: 'ADMIN' }, { type: 'ADD_TAG', tag: 'x' }])]);
    expect(r.winner).toBeNull();
    expect(r.suppressed.size).toBe(0);
  });
  it('multi-level approval maps to a REQUIRE_APPROVAL chain', () => {
    const r = resolveDecision([rule('m', 1, [{ type: 'REQUIRE_MULTI_LEVEL_APPROVAL', levels: [{ role: 'FINANCE_MANAGER' }, { role: 'ADMIN' }] }])]);
    expect(r.winner?.disposition.levels).toHaveLength(2);
  });
  it('ties on priority and severity fall back to creation order', () => {
    const r = resolveDecision([rule('b', 2, [{ type: 'AUTO_APPROVE' }], new Date(2026, 5, 1)), rule('a', 2, [{ type: 'AUTO_APPROVE' }], new Date(2026, 1, 1))]);
    expect(r.winner?.ruleId).toBe('a');
  });
});
