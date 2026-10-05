import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { runEvent, MAX_EVENT_DEPTH } from '../src/rules/engine';
import { addUser, api, bearer, createVendor, getInvoice, registerOrg, Session, upload } from './helpers';

afterEach(() => vi.unstubAllGlobals());

const cond = (...c: any[]) => ({ operator: 'AND', conditions: c });
const leaf = (field: string, operator: string, value: any) => ({ field, operator, value });
async function setup() {
  const s = await registerOrg();
  await createVendor(s, 'Acme Test Supplies');
  return s;
}
const makeRule = (s: Session, over: object = {}) =>
  api().post('/api/automation/rules').set(bearer(s)).send({ name: 'R', trigger: 'INVOICE_PROCESSED', priority: 50, conditions: cond(leaf('invoice.total', 'greater_than', 1)), actions: [{ type: 'ADD_TAG', tag: 'x' }], ...over });

describe('rule CRUD, validation and versioning', () => {
  it('creates, lists with stats, edits (new version + readable diff), disables, duplicates and soft-deletes', async () => {
    const s = await setup();
    const created = await makeRule(s, {
      name: 'High Value', priority: 1,
      conditions: cond(leaf('invoice.total', 'greater_than', 50000)),
      actions: [{ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.conditionsSummary).toContain('Invoice total is greater than 50000');
    expect(created.body.data.actionsSummary[0]).toBe('Require finance manager approval');

    const edit = await api().patch(`/api/automation/rules/${id}`).set(bearer(s)).send({ conditions: cond(leaf('invoice.total', 'greater_than', 75000)) });
    expect(edit.body.data.version).toBe(2);
    const versions = (await api().get(`/api/automation/rules/${id}/versions`).set(bearer(s))).body.data;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(versions[0].changeSummary).toBe('Condition changed: Invoice total is greater than 50000 → Invoice total is greater than 75000');
    expect(versions[0].changedByName).toBe('Test Owner');
    expect(versions[1].snapshot.conditions.conditions[0].value).toBe(50000); // old version preserved

    expect((await api().patch(`/api/automation/rules/${id}`).set(bearer(s)).send({ priority: 1 })).body.data.version).toBe(2); // no-op => no new version
    const off = await api().patch(`/api/automation/rules/${id}`).set(bearer(s)).send({ enabled: false });
    expect(off.body.data.enabled).toBe(false);
    expect((await api().get(`/api/automation/rules/${id}/versions`).set(bearer(s))).body.data[0].changeSummary).toBe('Rule disabled');

    const dup = await api().post(`/api/automation/rules/${id}/duplicate`).set(bearer(s));
    expect(dup.status).toBe(201);
    expect(dup.body.data).toMatchObject({ name: 'High Value (copy)', enabled: false, version: 1 });

    expect((await api().delete(`/api/automation/rules/${id}`).set(bearer(s))).status).toBe(200);
    expect((await api().get(`/api/automation/rules/${id}`).set(bearer(s))).status).toBe(404);
    const stillThere = await prisma.businessRule.findUnique({ where: { id } });
    expect(stillThere?.deletedAt).not.toBeNull(); // soft delete keeps history
    expect((await api().get(`/api/automation/rules/${id}/versions`).set(bearer(s))).body.data[0].changeSummary).toBe('Rule deleted');
    const list = (await api().get('/api/automation/rules').set(bearer(s))).body.data.items;
    expect(list.map((r: any) => r.id)).not.toContain(id);
    expect(await prisma.auditLog.count({ where: { organizationId: s.orgId, action: { in: ['rule.created', 'rule.modified', 'rule.deleted'] } } })).toBeGreaterThanOrEqual(10);
  });

  it('rejects invalid rules: bad fields/operators/actions, decision actions on post-decision triggers, missing action config', async () => {
    const s = await setup();
    const bad = async (over: object) => (await makeRule(s, over)).status;
    expect(await bad({ conditions: cond(leaf('invoice.hacked', 'equals', 1)) })).toBe(400);
    expect(await bad({ conditions: cond(leaf('invoice.total', 'drop_table', 1)) })).toBe(400);
    expect(await bad({ actions: [{ type: 'RUN_SCRIPT', code: 'process.exit()' }] })).toBe(400);
    expect(await bad({ actions: [] })).toBe(400);
    expect(await bad({ trigger: 'INVOICE_APPROVED', actions: [{ type: 'AUTO_APPROVE' }] })).toBe(400);
    expect(await bad({ actions: [{ type: 'REQUIRE_APPROVAL' }] })).toBe(400);
    expect(await bad({ actions: [{ type: 'REQUIRE_MULTI_LEVEL_APPROVAL', levels: [{ role: 'ADMIN' }] }] })).toBe(400);
    expect(await bad({ actions: [{ type: 'SEND_NOTIFICATION', recipient: 'USER' }] })).toBe(400);
    expect(await bad({ name: '' })).toBe(400);
    expect(await bad({ priority: 0 })).toBe(400);
    expect(await bad({ trigger: 'NOT_A_TRIGGER' })).toBe(400);
    expect(await bad({ trigger: 'INVOICE_APPROVED', actions: [{ type: 'ADD_TAG', tag: 'ok' }] })).toBe(201); // effects are fine
  });

  it('exposes builder metadata and templates from the backend', async () => {
    const s = await setup();
    const meta = (await api().get('/api/automation/metadata').set(bearer(s))).body.data;
    expect(meta.fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['invoice.total', 'invoice.riskLevel', 'vendor.group', 'invoice.aiConfidence']));
    expect(meta.triggers).toHaveLength(9);
    expect(meta.actions).toHaveLength(12);
    const t = (await api().get('/api/automation/templates').set(bearer(s))).body.data;
    expect(t.map((x: any) => x.key)).toEqual(expect.arrayContaining(['low-value-auto-approval', 'manager-approval', 'admin-approval', 'duplicate-review', 'missing-po']));
    // every shipped template is itself a valid rule
    for (const tpl of t) expect((await makeRule(s, { name: tpl.name, trigger: tpl.trigger, priority: tpl.priority, conditions: tpl.conditions, actions: tpl.actions })).status).toBe(201);
  });
});

describe('dry-run (rule tester)', () => {
  it('reports per-condition results and would-be actions WITHOUT executing anything', async () => {
    const s = await setup();
    await addUser(s, 'FINANCE_MANAGER');
    const up = await upload(s, { total: 92000, invoiceNumber: 'INV-1042', po: null });
    const invId = up.body.data.id;
    const rule = (
      await makeRule(s, {
        name: 'Tester', priority: 1,
        conditions: cond(leaf('invoice.total', 'greater_than', 50000), leaf('invoice.purchaseOrderPresent', 'equals', true)),
        actions: [{ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' }, { type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER' }, { type: 'ADD_TAG', tag: 'Dry Run Tag' }],
      })
    ).body.data;

    const snapshot = async () => ({
      approvals: await prisma.approval.count({ where: { organizationId: s.orgId } }),
      notifications: await prisma.notification.count({ where: { organizationId: s.orgId } }),
      executions: await prisma.businessRuleExecution.count({ where: { organizationId: s.orgId } }),
      tags: await prisma.tag.count({ where: { organizationId: s.orgId } }),
      invoice: JSON.stringify(await prisma.invoice.findUnique({ where: { id: invId } })),
      audit: await prisma.auditLog.count({ where: { organizationId: s.orgId } }),
    });
    const before = await snapshot();
    const res = await api().post(`/api/automation/rules/${rule.id}/test`).set(bearer(s)).send({ invoiceId: invId });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.matched).toBe(false); // PO is missing => second condition false
    expect(res.body.data.conditions).toEqual([
      expect.objectContaining({ field: 'invoice.total', operator: 'greater_than', expected: 50000, actual: 92000, matched: true }),
      expect.objectContaining({ field: 'invoice.purchaseOrderPresent', expected: true, actual: false, matched: false }),
    ]);
    expect(res.body.data.actions).toEqual([]);
    expect(await snapshot()).toEqual(before);

    await api().patch(`/api/automation/rules/${rule.id}`).set(bearer(s)).send({ conditions: cond(leaf('invoice.total', 'greater_than', 50000)) });
    const res2 = await api().post(`/api/automation/rules/${rule.id}/test`).set(bearer(s)).send({ invoiceId: invId });
    expect(res2.body.data.matched).toBe(true);
    expect(res2.body.data.actions).toEqual(['REQUIRE_APPROVAL', 'SEND_NOTIFICATION', 'ADD_TAG']);
    expect(res2.body.data.actionDetails[2].description).toBe('Add tag "Dry Run Tag"');
    expect(res2.body.data.decisionPreview).toMatchObject({ decidedBy: 'Tester' });
    const after = await snapshot();
    expect(after.approvals).toBe(before.approvals);
    expect(after.notifications).toBe(before.notifications);
    expect(after.tags).toBe(before.tags);
    expect(after.executions).toBe(before.executions);
    expect(after.invoice).toBe(before.invoice);
  });

  it('can test an UNSAVED draft and validates it', async () => {
    const s = await setup();
    const invId = (await upload(s, { total: 1000 })).body.data.id;
    const ok = await api().post('/api/automation/rules/test-draft').set(bearer(s)).send({ invoiceId: invId, name: 'Draft', trigger: 'INVOICE_PROCESSED', priority: 1, conditions: cond(leaf('invoice.total', 'less_than', 5000)), actions: [{ type: 'AUTO_APPROVE' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.matched).toBe(true);
    const bad = await api().post('/api/automation/rules/test-draft').set(bearer(s)).send({ invoiceId: invId, name: 'Draft', trigger: 'INVOICE_PROCESSED', priority: 1, conditions: cond(leaf('nope', 'equals', 1)), actions: [{ type: 'AUTO_APPROVE' }] });
    expect(bad.status).toBe(400);
    expect(await prisma.businessRule.count({ where: { organizationId: s.orgId, name: 'Draft' } })).toBe(0);
  });
});

describe('engine behaviour', () => {
  it('disabled and soft-deleted rules never execute; priority + equal-priority conflict resolve deterministically', async () => {
    const s = await setup();
    // switch off all defaults so only our rules decide
    const defaults = (await api().get('/api/automation/rules').set(bearer(s))).body.data.items;
    for (const r of defaults) await api().patch(`/api/automation/rules/${r.id}`).set(bearer(s)).send({ enabled: false });
    const auto = (await makeRule(s, { name: 'Auto', priority: 3, actions: [{ type: 'AUTO_APPROVE' }] })).body.data;
    const review = (await makeRule(s, { name: 'Review', priority: 3, actions: [{ type: 'REQUEST_HUMAN_REVIEW', reason: 'because' }] })).body.data;
    const inv = await getInvoice(s, (await upload(s, { total: 100 })).body.data.id);
    expect(inv.status).toBe('MANUAL_REVIEW'); // equal priority: restrictive wins over AUTO_APPROVE
    expect(inv.executions.find((e: any) => e.ruleName === 'Auto').actionsExecuted[0].status).toBe('SUPPRESSED');
    expect(inv.executions.find((e: any) => e.ruleName === 'Review').actionsExecuted[0].status).toBe('SUCCESS');

    await api().patch(`/api/automation/rules/${review.id}`).set(bearer(s)).send({ enabled: false });
    const inv2 = await getInvoice(s, (await upload(s, { total: 100 })).body.data.id);
    expect(inv2.status).toBe('APPROVED');
    expect(inv2.executions.find((e: any) => e.ruleName === 'Review')).toBeUndefined();

    await api().patch(`/api/automation/rules/${review.id}`).set(bearer(s)).send({ enabled: true, priority: 2 });
    expect((await getInvoice(s, (await upload(s, { total: 100 })).body.data.id)).status).toBe('MANUAL_REVIEW'); // priority 2 beats 3
    await api().delete(`/api/automation/rules/${review.id}`).set(bearer(s));
    expect((await getInvoice(s, (await upload(s, { total: 100 })).body.data.id)).status).toBe('APPROVED');
    void auto;
  });

  it('with no matching decision rule the invoice is routed to a finance manager, never auto-approved', async () => {
    const s = await setup();
    for (const r of (await api().get('/api/automation/rules').set(bearer(s))).body.data.items) await api().patch(`/api/automation/rules/${r.id}`).set(bearer(s)).send({ enabled: false });
    const inv = await getInvoice(s, (await upload(s, { total: 100 })).body.data.id);
    expect(inv.status).toBe('PENDING_APPROVAL');
    expect(inv.approvals[0].approverRole).toBe('FINANCE_MANAGER');
    expect(inv.timeline.find((t: any) => t.action === 'invoice.processed').metadata.override).toMatch(/safe default/);
  });

  it('OR + nested conditions work end to end; vendor-group and AI confidence conditions work', async () => {
    const s = await setup();
    await api().patch(`/api/vendors/${(await api().get('/api/vendors').set(bearer(s))).body.data.items[0].id}`).set(bearer(s)).send({ group: 'strategic' });
    await makeRule(s, {
      name: 'Nested', priority: 1,
      conditions: { operator: 'OR', conditions: [{ operator: 'AND', conditions: [leaf('invoice.total', 'greater_than', 100000), leaf('invoice.riskLevel', 'equals', 'HIGH')] }, leaf('vendor.group', 'equals', 'strategic')] },
      actions: [{ type: 'ADD_TAG', tag: 'Strategic' }],
    });
    const inv = await getInvoice(s, (await upload(s, { total: 100 })).body.data.id);
    expect(inv.tags).toContain('Strategic');
    expect(inv.executions.find((e: any) => e.ruleName === 'Nested').conditionsEvaluated.operator).toBe('OR');
  });

  it('chained triggers run once, are depth-limited, and cannot loop', async () => {
    const s = await setup();
    // A rule on INVOICE_APPROVED that notifies, plus one on APPROVAL_COMPLETED.
    await makeRule(s, { name: 'On approved', trigger: 'INVOICE_APPROVED', actions: [{ type: 'SEND_NOTIFICATION', recipient: 'UPLOADER', message: 'Approved {{invoiceNumber}}' }, { type: 'ADD_TAG', tag: 'Approved Tag' }] });
    await makeRule(s, { name: 'On approval completed', trigger: 'APPROVAL_COMPLETED', actions: [{ type: 'ADD_TAG', tag: 'Completed Tag' }] });
    const auto = await getInvoice(s, (await upload(s, { total: 100, invoiceNumber: 'CHAIN-1' })).body.data.id);
    expect(auto.status).toBe('APPROVED');
    expect(auto.tags).toContain('Approved Tag'); // auto-approval fires INVOICE_APPROVED at depth 1
    const e = auto.executions.filter((x: any) => x.ruleName === 'On approved');
    expect(e).toHaveLength(1);
    expect(e[0].depth).toBe(1);

    const mgrInv = await getInvoice(s, (await upload(s, { total: 40000 })).body.data.id);
    await api().post(`/api/approvals/${mgrInv.approvals[0].id}/approve`).set(bearer(s)).send({});
    const after = await getInvoice(s, mgrInv.id);
    expect(after.tags).toEqual(expect.arrayContaining(['Approved Tag', 'Completed Tag']));
    expect(after.executions.filter((x: any) => x.ruleName === 'On approved')).toHaveLength(1);

    // Loop protection: beyond MAX depth the engine records `rule.loop_prevented` and does nothing.
    await prisma.$transaction(async (tx) => {
      const out = await runEvent({ tx, organizationId: s.orgId, invoiceId: after.id, triggers: ['INVOICE_APPROVED'], runKey: 'loop-test', depth: MAX_EVENT_DEPTH + 1 });
      expect(out.evaluations).toHaveLength(0);
    });
    expect(await prisma.auditLog.count({ where: { invoiceId: after.id, action: 'rule.loop_prevented' } })).toBe(1);
    // Same event + runKey a second time => rules are NOT executed twice (execution key already recorded)
    const before = await prisma.businessRuleExecution.count({ where: { invoiceId: after.id } });
    await prisma.$transaction((tx) => runEvent({ tx, organizationId: s.orgId, invoiceId: after.id, triggers: ['INVOICE_APPROVED'], runKey: 'once', depth: 1 }));
    const mid = await prisma.businessRuleExecution.count({ where: { invoiceId: after.id } });
    await prisma.$transaction((tx) => runEvent({ tx, organizationId: s.orgId, invoiceId: after.id, triggers: ['INVOICE_APPROVED'], runKey: 'once', depth: 1 }));
    expect(mid).toBeGreaterThan(before);
    expect(await prisma.businessRuleExecution.count({ where: { invoiceId: after.id } })).toBe(mid);
  });

  it('actions: create task (assigned, due date, templated), set risk level, notify specific user, update status failures are recorded not faked', async () => {
    const s = await setup();
    const fm = await addUser(s, 'FINANCE_MANAGER');
    await makeRule(s, {
      name: 'Kitchen sink', priority: 1,
      actions: [
        { type: 'CREATE_TASK', title: 'Check {{invoiceNumber}} from {{vendorName}}', priority: 'HIGH', assignTo: 'FINANCE_MANAGER', dueInDays: 2 },
        { type: 'SET_RISK_LEVEL', level: 'CRITICAL' },
        { type: 'SEND_NOTIFICATION', recipient: 'USER', userId: fm.userId, title: 'Hello {{vendorName}}' },
        { type: 'UPDATE_STATUS', status: 'PAID' }, // invalid at this point (not APPROVED) => must be recorded as FAILED
      ],
    });
    const inv = await getInvoice(s, (await upload(s, { total: 40000, invoiceNumber: 'K-1' })).body.data.id);
    const ex = inv.executions.find((e: any) => e.ruleName === 'Kitchen sink');
    expect(ex.result).toBe('PARTIAL_FAILURE');
    expect(ex.actionsExecuted.map((a: any) => a.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILED']);
    expect(ex.actionsExecuted[3].detail).toMatch(/PAID/);
    expect(inv.riskLevel).toBe('CRITICAL');
    expect(inv.tasks[0]).toMatchObject({ title: 'Check K-1 from Acme Test Supplies', priority: 'HIGH', assigneeRole: 'FINANCE_MANAGER' });
    const due = new Date(inv.tasks[0].dueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(1.9 * 86400000);
    expect((await api().get('/api/notifications').set(bearer(fm))).body.data.items.some((n: any) => n.title === 'Hello Acme Test Supplies')).toBe(true);
    const tasks = await api().get('/api/tasks').set(bearer(s));
    expect(tasks.body.data.length).toBeGreaterThan(0);
    expect((await api().post(`/api/tasks/${inv.tasks[0].id}/complete`).set(bearer(s))).status).toBe(200);
  });

  it('a corrupted stored rule is recorded as an error and cannot crash processing', async () => {
    const s = await setup();
    const r = (await makeRule(s, { name: 'Will corrupt', priority: 1 })).body.data;
    await prisma.businessRule.update({ where: { id: r.id }, data: { conditions: { evil: 'process.exit(1)' } } });
    const inv = await getInvoice(s, (await upload(s, { total: 100 })).body.data.id);
    expect(inv.status).toBe('APPROVED');
    const ex = inv.executions.find((e: any) => e.ruleName === 'Will corrupt');
    expect(ex.matched).toBe(false);
    expect(ex.error).toMatch(/Invalid stored rule/);
  });
});

describe('execution history and audit', () => {
  it('lists/filters executions and returns detail with the evaluated tree', async () => {
    const s = await setup();
    const inv = await getInvoice(s, (await upload(s, { total: 5000 })).body.data.id);
    const matched = (await api().get('/api/automation/executions').set(bearer(s)).query({ matched: 'true', invoiceId: inv.id })).body.data;
    expect(matched.items.length).toBeGreaterThan(0);
    expect(matched.items[0]).toMatchObject({ invoiceNumber: inv.invoiceNumber, matched: true });
    expect(matched.items.every((e: any) => e.durationMs >= 1)).toBe(true);
    const detail = (await api().get(`/api/automation/executions/${matched.items[0].id}`).set(bearer(s))).body.data;
    expect(detail.conditionsEvaluated.type).toBe('group');
    expect(detail.invoice.id).toBe(inv.id);
    const all = (await api().get('/api/automation/executions').set(bearer(s)).query({ invoiceId: inv.id, pageSize: 2, page: 1 })).body.data;
    expect(all.meta.pageSize).toBe(2);
    const rules = (await api().get('/api/automation/rules').set(bearer(s))).body.data.items;
    const auto = rules.find((r: any) => r.templateKey === 'low-value-auto-approval');
    expect(auto.executionCount).toBe(1);
    expect(auto.lastExecutionAt).toBeTruthy();
  });
});

describe('AI settings security', () => {
  const KEY = 'AIzaSyFAKE_KEY_FOR_TESTS_1234567890abcd';
  it('validates, encrypts at rest, masks the key everywhere, and never leaks it', async () => {
    const s = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const v = await api().post('/api/settings/ai/validate').set(bearer(s)).send({ apiKey: KEY });
    expect(v.body.data).toEqual({ valid: true });
    expect(JSON.stringify(v.body)).not.toContain(KEY);

    const put = await api().put('/api/settings/ai').set(bearer(s)).send({ mode: 'GEMINI', apiKey: KEY });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(KEY);
    expect(put.body.data).toMatchObject({ mode: 'GEMINI', hasKey: true });
    expect(put.body.data.maskedKey).toMatch(/^•+abcd$/);

    const get = await api().get('/api/settings/ai').set(bearer(s));
    expect(JSON.stringify(get.body)).not.toContain(KEY);

    const row = await prisma.credential.findFirstOrThrow({ where: { organizationId: s.orgId } });
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain('AIzaSy');
    const audit = await prisma.auditLog.findMany({ where: { organizationId: s.orgId, action: { startsWith: 'ai.' } } });
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit)).not.toContain(KEY);

    // Gemini mode uses the stored key (header only) and real extraction path
    const geminiJson = { invoiceNumber: 'G-1', vendorName: 'Acme Test Supplies', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'INR', subtotal: 800, tax: 0, total: 800, purchaseOrderNumber: 'PO-9', lineItems: [{ description: 'x', quantity: 1, unitPrice: 800, lineTotal: 800 }], confidence: 0.93 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiJson) }] } }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const inv = await getInvoice(s, (await upload(s, { total: 1 })).body.data.id);
    expect(inv.invoiceNumber).toBe('G-1');
    expect(inv.status).toBe('APPROVED');
    expect((fetchMock.mock.calls[0][1] as any).headers['x-goog-api-key']).toBe(KEY);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(KEY);
    expect(inv.aiJobs[0].provider).toBe('gemini');

    const del = await api().delete('/api/settings/ai').set(bearer(s));
    expect(del.body.data).toMatchObject({ hasKey: false, mode: 'MOCK' });
    expect(await prisma.credential.count({ where: { organizationId: s.orgId } })).toBe(0);
  });

  it('refuses an invalid key and Gemini mode without any key', async () => {
    const s = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    expect((await api().put('/api/settings/ai').set(bearer(s)).send({ mode: 'GEMINI', apiKey: KEY })).body.error.code).toBe('INVALID_AI_KEY');
    expect((await api().put('/api/settings/ai').set(bearer(s)).send({ mode: 'GEMINI' })).body.error.code).toBe('API_KEY_REQUIRED');
    expect(await prisma.credential.count({ where: { organizationId: s.orgId } })).toBe(0);
  });

  it("one org's key is never used for another org", async () => {
    const a = await setup();
    const b = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await api().put('/api/settings/ai').set(bearer(a)).send({ mode: 'GEMINI', apiKey: KEY });
    expect((await api().get('/api/settings/ai').set(bearer(b))).body.data).toMatchObject({ hasKey: false, mode: 'MOCK' });
  });
});

describe('analytics, notifications, vendors, docs, health', () => {
  it('dashboard and automation analytics compute from real data', async () => {
    const s = await setup();
    await addUser(s, 'FINANCE_MANAGER');
    await upload(s, { total: 5000 }); // auto
    await upload(s, { total: 6000 }); // auto
    await upload(s, { total: 40000 }); // pending
    await upload(s, { total: 3000, confidence: 0.3 }); // manual review
    const d = (await api().get('/api/analytics/dashboard').set(bearer(s))).body.data;
    expect(d.kpis).toMatchObject({ invoicesProcessed: 4, pendingApproval: 1, approved: 2, exceptions: 1, automationRate: 50, manualReviewRate: 50 });
    expect(d.kpis.totalSpend).toBe(11000);
    expect(d.charts.statusBreakdown.find((x: any) => x.status === 'APPROVED').count).toBe(2);
    expect(d.charts.vendorSpend[0]).toMatchObject({ vendor: 'Acme Test Supplies' });
    expect(d.charts.riskDistribution).toHaveLength(4);
    expect(d.charts.monthly.length).toBeGreaterThan(0);
    const a = (await api().get('/api/analytics/automation').set(bearer(s))).body.data;
    expect(a.mostTriggered[0].executions).toBeGreaterThan(0);
    const auto = a.rules.find((r: any) => r.name === 'Low Value Auto Approval');
    expect(auto).toMatchObject({ executions: 2, successful: 2, failed: 0 });
    expect(a.automationRate).toBe(50);
  });

  it('notifications can be listed and marked read, per user', async () => {
    const s = await setup();
    const fm = await addUser(s, 'FINANCE_MANAGER');
    await upload(s, { total: 40000 });
    const list = (await api().get('/api/notifications').set(bearer(fm))).body.data;
    expect(list.unread).toBeGreaterThan(0);
    expect((await api().post(`/api/notifications/${list.items[0].id}/read`).set(bearer(s))).status).toBe(404); // not the owner's notification
    expect((await api().post(`/api/notifications/${list.items[0].id}/read`).set(bearer(fm))).status).toBe(200);
    await api().post('/api/notifications/read-all').set(bearer(fm));
    expect((await api().get('/api/notifications').set(bearer(fm))).body.data.unread).toBe(0);
  });

  it('vendors: create, duplicate rejected, detail with spend', async () => {
    const s = await registerOrg();
    const v = await api().post('/api/vendors').set(bearer(s)).send({ name: 'Zeta Corp', industry: 'IT', group: 'preferred' });
    expect(v.status).toBe(201);
    expect((await api().post('/api/vendors').set(bearer(s)).send({ name: ' zeta   corp ' })).status).toBe(409);
    await upload(s, { vendorName: 'Zeta Corp', total: 5000 });
    const detail = (await api().get(`/api/vendors/${v.body.data.id}`).set(bearer(s))).body.data;
    expect(detail).toMatchObject({ invoiceCount: 1, totalSpend: 5000 });
  });

  it('invoice list supports search, filters, sorting and pagination', async () => {
    const s = await setup();
    for (const t of [1000, 2000, 3000]) await upload(s, { total: t, invoiceNumber: `LIST-${t}` });
    const list = (q: object) => api().get('/api/invoices').set(bearer(s)).query(q);
    expect((await list({ search: 'LIST-2000' })).body.data.items).toHaveLength(1);
    expect((await list({ minAmount: 1500 })).body.data.items).toHaveLength(2);
    expect((await list({ sortBy: 'total', sortDir: 'desc' })).body.data.items[0].total).toBe(3000);
    const p = (await list({ pageSize: 2, page: 2 })).body.data;
    expect(p.items).toHaveLength(1);
    expect(p.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect((await list({ status: 'BOGUS' })).status).toBe(400);
  });

  it('serves OpenAPI docs, health, a uniform error format, and security headers', async () => {
    const docs = await api().get('/api/docs/');
    expect(docs.status).toBe(200);
    const health = await api().get('/api/health');
    expect(health.body.data).toMatchObject({ database: true });
    const nf = await api().get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-powered-by']).toBeUndefined();
    const s = await registerOrg();
    const bad = await api().get('/api/invoices/not-a-uuid').set(bearer(s));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const malformed = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(malformed.body.error.code).toBe('INVALID_JSON');
  });
});
