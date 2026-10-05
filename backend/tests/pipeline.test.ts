import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db';
import { MockAIProvider } from '../src/ai/mock.provider';
import { AIProviderError } from '../src/ai/types';
import { processInvoice } from '../src/invoices/pipeline';
import { enqueueInvoiceProcessing } from '../src/jobs/queue';
import { addUser, api, bearer, createVendor, getInvoice, mockData, pdf, registerOrg, Session, upload } from './helpers';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const s = await registerOrg();
  await createVendor(s, 'Acme Test Supplies'); // verified vendor => no "unknown vendor" anomaly
  return s;
}
const run = async (s: Session, spec: object = {}, opts = {}) => {
  const res = await upload(s, spec, opts);
  expect(res.status).toBe(201);
  return getInvoice(s, res.body.data.id);
};
const ruleResult = (inv: any, name: string) => inv.executions.find((e: any) => e.ruleName === name && e.depth === 0);

describe('default policies end to end', () => {
  it('auto-approves low-value, low-risk, high-confidence invoices', async () => {
    const s = await setup();
    const inv = await run(s, { total: 5000 });
    expect(inv.status).toBe('APPROVED');
    expect(inv.autoApproved).toBe(true);
    expect(inv.riskLevel).toBe('LOW');
    expect(inv.processingStatus).toBe('COMPLETED');
    expect(ruleResult(inv, 'Low Value Auto Approval').matched).toBe(true);
    expect(ruleResult(inv, 'Duplicate Invoice Review')).toBeUndefined(); // trigger not fired -> not evaluated
    expect(inv.timeline.map((t: any) => t.action)).toEqual(expect.arrayContaining(['invoice.uploaded', 'invoice.extracted', 'invoice.validated', 'rule.matched', 'invoice.auto_approved', 'invoice.processed']));
    const notes = await api().get('/api/notifications').set(bearer(s));
    expect(notes.body.data.items.some((n: any) => n.title === 'Invoice approved automatically')).toBe(true);
  });

  it('routes mid-value invoices to the finance manager and notifies them', async () => {
    const s = await setup();
    const mgr = await addUser(s, 'FINANCE_MANAGER');
    const inv = await run(s, { total: 40000 });
    expect(inv.status).toBe('PENDING_APPROVAL');
    expect(inv.approvals).toHaveLength(1);
    expect(inv.approvals[0]).toMatchObject({ approverRole: 'FINANCE_MANAGER', status: 'PENDING', level: 1 });
    const mgrNotes = await api().get('/api/notifications').set(bearer(mgr));
    expect(mgrNotes.body.data.items.some((n: any) => n.invoiceId === inv.id)).toBe(true);
  });

  it('requires ADMIN approval at >= 100,000 and tags the invoice', async () => {
    const s = await setup();
    const inv = await run(s, { total: 250000 });
    expect(inv.approvals[0].approverRole).toBe('ADMIN');
    expect(inv.tags).toContain('High Value');
  });

  it('missing PO on a large invoice goes to manual review (higher priority than manager approval)', async () => {
    const s = await setup();
    const inv = await run(s, { total: 40000, po: null });
    expect(inv.status).toBe('MANUAL_REVIEW');
    expect(inv.exceptionReasons.join(' ')).toMatch(/purchase order/i);
    expect(inv.approvals).toHaveLength(0);
    const mgrRule = ruleResult(inv, 'Manager Approval (10,000 – 100,000)');
    expect(mgrRule.matched).toBe(true);
    expect(mgrRule.actionsExecuted.find((a: any) => a.type === 'REQUIRE_APPROVAL').status).toBe('SUPPRESSED');
    const list = await api().get('/api/exceptions').set(bearer(s));
    expect(list.body.data.items.map((i: any) => i.id)).toContain(inv.id);
  });

  it('low AI confidence forces human review', async () => {
    const s = await setup();
    const inv = await run(s, { total: 3000, confidence: 0.5 });
    expect(inv.status).toBe('MANUAL_REVIEW');
    expect(inv.autoApproved).toBe(false);
  });

  it('unknown vendors are created unverified, raise risk and are never auto-approved', async () => {
    const s = await registerOrg();
    const inv = await run(s, { total: 3000, vendorName: 'Brand New Vendor LLC' });
    expect(inv.vendor.verified).toBe(false);
    expect(inv.riskLevel).toBe('MEDIUM');
    expect(inv.status).not.toBe('APPROVED');
    expect(inv.anomalies.map((a: any) => a.code)).toContain('UNKNOWN_VENDOR');
  });
});

describe('validation, duplicates, anomalies', () => {
  it('arithmetic mismatch is blocking: forces manual review even if a rule would auto-approve', async () => {
    const s = await setup();
    const inv = await run(s, { total: 5000, subtotal: 4000, tax: 500 }); // 4000 + 500 != 5000
    expect(inv.validation.findings.map((f: any) => f.code)).toContain('TOTAL_MISMATCH');
    expect(inv.status).toBe('MANUAL_REVIEW');
    const audit = inv.timeline.find((t: any) => t.action === 'invoice.processed');
    expect(audit.metadata.override).toMatch(/safety floor/i);
    const auto = ruleResult(inv, 'Low Value Auto Approval');
    if (auto?.matched) expect(auto.actionsExecuted.find((a: any) => a.type === 'AUTO_APPROVE').status).toBe('SUPPRESSED');
  });

  it('detects duplicates by vendor + number + date + total and by file fingerprint', async () => {
    const s = await setup();
    const spec = { invoiceNumber: 'DUP-1', total: 12000 };
    const first = await run(s, spec);
    const second = await run(s, spec); // different file bytes, same business key
    expect(first.duplicateDetected).toBe(false);
    expect(second.duplicateDetected).toBe(true);
    expect(second.duplicateOf.id).toBe(first.id);
    expect(second.riskLevel === 'HIGH' || second.riskLevel === 'CRITICAL').toBe(true);
    expect(second.status).toBe('MANUAL_REVIEW');
    expect(second.timeline.some((t: any) => t.action === 'invoice.duplicate_detected')).toBe(true);

    const nonce = 'same-bytes';
    const a = await run(s, { invoiceNumber: 'F-1', total: 100 }, { nonce });
    const b = await run(s, { invoiceNumber: 'F-1-other', total: 100 }, { nonce }); // data differs, but identical bytes? (data embedded) -> only equal if same data
    expect(a.duplicateDetected).toBe(false);
    expect(b.duplicateDetected).toBe(false); // content differs, so fingerprints differ
    const c = await upload(s, { invoiceNumber: 'F-2', total: 100 }, { nonce: 'x1' });
    const d = await upload(s, { invoiceNumber: 'F-2', total: 100 }, { nonce: 'x1' }); // byte-identical file
    expect((await getInvoice(s, d.body.data.id)).duplicateDetected).toBe(true);
    expect((await getInvoice(s, c.body.data.id)).duplicateDetected).toBe(false);
  });

  it('re-processing the ORIGINAL never flags it as a duplicate of its own copy', async () => {
    const s = await setup();
    const first = await run(s, { invoiceNumber: 'ORIG-1', total: 12000 });
    await run(s, { invoiceNumber: 'ORIG-1', total: 12000 });
    const re = await api().post(`/api/invoices/${first.id}/reprocess`).set(bearer(s)).send({});
    expect(re.status).toBe(202);
    expect((await getInvoice(s, first.id)).duplicateDetected).toBe(false);
  });

  it('duplicates in another organization are not duplicates', async () => {
    const a = await setup();
    const b = await setup();
    await run(a, { invoiceNumber: 'X-9', total: 8000 });
    const inv = await run(b, { invoiceNumber: 'X-9', total: 8000 });
    expect(inv.duplicateDetected).toBe(false);
  });
});

describe('spec scenario: ₹92,000 invoice with a company rule', () => {
  it('Register → create rule → upload → extract → validate → rule matches → approval + notification + tag + audit', async () => {
    const s = await setup();
    const mgr = await addUser(s, 'FINANCE_MANAGER');

    const create = await api().post('/api/automation/rules').set(bearer(s)).send({
      name: 'High Value Risky Invoice', description: 'Manager approval over 75k when risk is not low', trigger: 'INVOICE_PROCESSED', priority: 2,
      conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'greater_than', value: 75000 }, { field: 'invoice.riskLevel', operator: 'not_equals', value: 'LOW' }] },
      actions: [
        { type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' },
        { type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER', message: 'Invoice {{invoiceNumber}} requires approval. Vendor: {{vendorName}}. Amount: {{total}}.' },
        { type: 'ADD_TAG', tag: 'High Risk' },
        { type: 'CREATE_TASK', title: 'Review invoice {{invoiceNumber}}', priority: 'HIGH', assignTo: 'FINANCE_MANAGER', dueInDays: 2 },
      ],
    });
    expect(create.status).toBe(201);

    // ₹92,000 with tax mismatch of a few rupees -> elevated (non-LOW) risk without hitting the blocking safety floor
    const inv = await run(s, { invoiceNumber: 'INV-1042', total: 92000, subtotal: 77966.1, tax: 14033.9, po: null, confidence: 0.65 });
    expect(['MEDIUM', 'HIGH', 'CRITICAL']).toContain(inv.riskLevel);

    // Missing-PO (>25k) and Low-Confidence rules have higher priority than priority 2? No: they are 3 and 4, so ours wins.
    expect(inv.status).toBe('PENDING_APPROVAL');
    expect(inv.approvals).toHaveLength(1);
    expect(inv.tags).toContain('High Risk');
    expect(inv.tasks).toHaveLength(1);
    expect(inv.tasks[0].title).toBe('Review invoice INV-1042');
    const exec = ruleResult(inv, 'High Value Risky Invoice');
    expect(exec).toMatchObject({ matched: true, result: 'SUCCESS' });
    expect(exec.actionsExecuted.map((a: any) => a.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS']);
    expect(exec.conditionsEvaluated.children.every((c: any) => c.matched)).toBe(true);

    const notes = (await api().get('/api/notifications').set(bearer(mgr))).body.data.items;
    const custom = notes.find((n: any) => n.message.startsWith('Invoice INV-1042 requires approval. Vendor: Acme Test Supplies. Amount: INR'));
    expect(custom).toBeTruthy();

    const audit = (await api().get('/api/audit-logs').set(bearer(s)).query({ invoiceId: inv.id })).body.data.items.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['rule.matched', 'approval.requested', 'invoice.processed']));
    expect(await prisma.businessRuleExecution.count({ where: { invoiceId: inv.id, matched: true, ruleName: 'High Value Risky Invoice' } })).toBe(1);
  });
});

describe('idempotency & concurrency', () => {
  it('processing the same run twice (or concurrently) never duplicates approvals, notifications, executions or tasks', async () => {
    const s = await setup();
    await addUser(s, 'FINANCE_MANAGER');
    const inv = await run(s, { total: 40000 });
    const counts = async () => ({
      approvals: await prisma.approval.count({ where: { invoiceId: inv.id } }),
      notifications: await prisma.notification.count({ where: { invoiceId: inv.id } }),
      executions: await prisma.businessRuleExecution.count({ where: { invoiceId: inv.id } }),
      audit: await prisma.auditLog.count({ where: { invoiceId: inv.id } }),
    });
    const before = await counts();
    const results = await Promise.all([processInvoice(inv.id, 1), processInvoice(inv.id, 1), enqueueInvoiceProcessing({ invoiceId: inv.id, organizationId: s.orgId, run: 1 })]);
    expect(results.slice(0, 2).every((r: any) => r.skipped)).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it('two workers racing on a fresh run: exactly one wins', async () => {
    const s = await setup();
    const up = await run(s, { total: 40000 });
    await api().post(`/api/invoices/${up.id}/reprocess`).set(bearer(s)).send({}); // run 2 done inline
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: up.id } });
    expect(row.completedRun).toBe(2);
    await prisma.invoice.update({ where: { id: up.id }, data: { processingRun: 3, completedRun: 2 } });
    const [a, b] = await Promise.all([processInvoice(up.id, 3), processInvoice(up.id, 3)]);
    expect([a, b].filter((r: any) => !r.skipped)).toHaveLength(1);
    expect(await prisma.approval.count({ where: { invoiceId: up.id, status: 'PENDING' } })).toBe(1);
  });

  it('re-processing supersedes the old run: old approvals cancelled, a single new pending approval', async () => {
    const s = await setup();
    const inv = await run(s, { total: 40000 });
    const re = await api().post(`/api/invoices/${inv.id}/reprocess`).set(bearer(s)).send({});
    expect(re.status).toBe(202);
    const after = await getInvoice(s, inv.id);
    expect(after.approvals.filter((a: any) => a.status === 'PENDING')).toHaveLength(1);
    expect(after.approvals.filter((a: any) => a.status === 'CANCELLED')).toHaveLength(1);
    expect(after.status).toBe('PENDING_APPROVAL');
  });

  it('approved/rejected invoices cannot be re-processed', async () => {
    const s = await setup();
    const inv = await run(s, { total: 5000 });
    expect((await api().post(`/api/invoices/${inv.id}/reprocess`).set(bearer(s)).send({})).status).toBe(409);
  });
});

describe('failures and retries', () => {
  it('retries transient AI failures and succeeds on the 3rd attempt', async () => {
    const s = await setup();
    const spy = vi.spyOn(MockAIProvider.prototype, 'extractInvoice');
    spy.mockRejectedValueOnce(new AIProviderError('temporary 503', true)).mockRejectedValueOnce(new AIProviderError('temporary 503', true));
    const inv = await run(s, { total: 5000 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(inv.status).toBe('APPROVED');
    expect(await prisma.aIProcessingJob.count({ where: { invoiceId: inv.id } })).toBe(3);
  });

  it('after 3 failed attempts the invoice is FAILED, in the exception queue, with notification + audit', async () => {
    const s = await setup();
    const fm = await addUser(s, 'FINANCE_MANAGER');
    const spy = vi.spyOn(MockAIProvider.prototype, 'extractInvoice').mockRejectedValue(new AIProviderError('model overloaded', true));
    const inv = await run(s, { total: 5000 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(inv.status).toBe('FAILED');
    expect(inv.failureReason).toMatch(/overloaded/);
    expect(inv.timeline.some((t: any) => t.action === 'invoice.processing_failed')).toBe(true);
    expect((await api().get('/api/exceptions').set(bearer(s))).body.data.items.map((i: any) => i.id)).toContain(inv.id);
    expect((await api().get('/api/notifications').set(bearer(fm))).body.data.items.some((n: any) => n.type === 'PROCESSING_FAILED')).toBe(true);
    spy.mockRestore();
    const retry = await api().post(`/api/invoices/${inv.id}/reprocess`).set(bearer(s)).send({ reextract: true });
    expect(retry.status).toBe(202);
    expect((await getInvoice(s, inv.id)).status).toBe('APPROVED');
  });

  it('non-retryable errors are not retried; Gemini mode without a key never silently uses mock data', async () => {
    const s = await setup();
    await prisma.organizationSettings.update({ where: { organizationId: s.orgId }, data: { aiMode: 'GEMINI' } });
    const spy = vi.spyOn(MockAIProvider.prototype, 'extractInvoice');
    const inv = await run(s, { total: 5000 });
    expect(spy).not.toHaveBeenCalled();
    expect(inv.status).toBe('FAILED');
    expect(inv.failureReason).toMatch(/no API key/i);
    expect(await prisma.aIProcessingJob.count({ where: { invoiceId: inv.id } })).toBe(1);
  });

  it('garbage extraction output from the provider is handled as a failure, not a crash', async () => {
    const s = await setup();
    vi.spyOn(MockAIProvider.prototype, 'extractInvoice').mockRejectedValue(new AIProviderError('Gemini output failed schema validation', true));
    const inv = await run(s, {});
    expect(inv.status).toBe('FAILED');
  });
});

describe('manual entry, editing and exception resolution', () => {
  it('manual invoices run through the same pipeline', async () => {
    const s = await setup();
    const res = await api().post('/api/invoices/manual').set(bearer(s)).send({ invoiceNumber: 'M-1', vendorName: 'Acme Test Supplies', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'INR', subtotal: 2000, tax: 0, total: 2000, purchaseOrderNumber: 'PO-1', lineItems: [{ description: 'Work', quantity: 2, unitPrice: 1000 }] });
    expect(res.status).toBe(201);
    const inv = await getInvoice(s, res.body.data.id);
    expect(inv.source).toBe('MANUAL');
    expect(inv.status).toBe('APPROVED');
    expect(inv.lineItems).toHaveLength(1);
  });

  it('edit a flagged invoice, re-run validation/rules without calling the AI again, then it flows on', async () => {
    const s = await setup();
    const bad = await run(s, { total: 9000, subtotal: 8000, tax: 500 });
    expect(bad.status).toBe('MANUAL_REVIEW');
    const spy = vi.spyOn(MockAIProvider.prototype, 'extractInvoice');
    expect((await api().patch(`/api/invoices/${bad.id}`).set(bearer(s)).send({ tax: 1000 })).status).toBe(200);
    expect((await api().post(`/api/invoices/${bad.id}/reprocess`).set(bearer(s)).send({})).status).toBe(202);
    expect(spy).not.toHaveBeenCalled();
    const fixed = await getInvoice(s, bad.id);
    expect(fixed.status).toBe('APPROVED');
    expect(fixed.timeline.some((t: any) => t.action === 'invoice.edited')).toBe(true);
    expect((await api().patch(`/api/invoices/${bad.id}`).set(bearer(s)).send({ tax: 1 })).status).toBe(409); // approved invoices are locked
  });

  it('exception queue actions: send for approval, reject (reason required), approve', async () => {
    const s = await setup();
    const viewer = await addUser(s, 'VIEWER');
    const fu = await addUser(s, 'FINANCE_USER');
    const mk = async () => run(s, { total: 3000, confidence: 0.4 });
    const a = await mk();
    const b = await mk();
    const c = await mk();
    expect((await api().post(`/api/exceptions/${a.id}/resolve`).set(bearer(viewer)).send({ action: 'SEND_FOR_APPROVAL' })).status).toBe(403);
    expect((await api().post(`/api/exceptions/${a.id}/resolve`).set(bearer(fu)).send({ action: 'APPROVE' })).status).toBe(403); // finance user can't approve
    expect((await api().post(`/api/exceptions/${a.id}/resolve`).set(bearer(fu)).send({ action: 'SEND_FOR_APPROVAL' })).status).toBe(200);
    expect((await getInvoice(s, a.id)).status).toBe('PENDING_APPROVAL');
    expect((await api().post(`/api/exceptions/${b.id}/resolve`).set(bearer(s)).send({ action: 'REJECT' })).status).toBe(400);
    expect((await api().post(`/api/exceptions/${b.id}/resolve`).set(bearer(s)).send({ action: 'REJECT', note: 'Not ours' })).status).toBe(200);
    expect((await getInvoice(s, b.id)).status).toBe('REJECTED');
    expect((await api().post(`/api/exceptions/${c.id}/resolve`).set(bearer(s)).send({ action: 'APPROVE' })).status).toBe(200);
    expect((await api().post(`/api/exceptions/${c.id}/resolve`).set(bearer(s)).send({ action: 'APPROVE' })).status).toBe(409); // no longer an exception
  });
});

describe('approval workflow', () => {
  it('reject requires a reason; approve/reject are single-use; double-click safe', async () => {
    const s = await setup();
    const inv = await run(s, { total: 40000 });
    const id = inv.approvals[0].id;
    expect((await api().post(`/api/approvals/${id}/reject`).set(bearer(s)).send({})).status).toBe(400);
    const [x, y] = await Promise.all([api().post(`/api/approvals/${id}/approve`).set(bearer(s)).send({}), api().post(`/api/approvals/${id}/approve`).set(bearer(s)).send({})]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const after = await getInvoice(s, inv.id);
    expect(after.status).toBe('APPROVED');
    expect(after.approvedBy).toBe(s.userId);
    expect((await api().post(`/api/approvals/${id}/reject`).set(bearer(s)).send({ comment: 'too late' })).status).toBe(409);
  });

  it('rejecting records the reason, cancels remaining levels and notifies the uploader', async () => {
    const s = await setup();
    const fu = await addUser(s, 'FINANCE_USER');
    const up = await upload(fu, { total: 40000 });
    const inv = await getInvoice(s, up.body.data.id);
    const r = await api().post(`/api/approvals/${inv.approvals[0].id}/reject`).set(bearer(s)).send({ comment: 'Wrong amount' });
    expect(r.status).toBe(200);
    const after = await getInvoice(s, inv.id);
    expect(after).toMatchObject({ status: 'REJECTED', rejectionReason: 'Wrong amount' });
    const notes = (await api().get('/api/notifications').set(bearer(fu))).body.data.items;
    expect(notes.some((n: any) => n.type === 'INVOICE_REJECTED')).toBe(true);
  });

  it('request changes sends the invoice back to the exception queue', async () => {
    const s = await setup();
    const inv = await run(s, { total: 40000 });
    expect((await api().post(`/api/approvals/${inv.approvals[0].id}/request-changes`).set(bearer(s)).send({})).status).toBe(400);
    expect((await api().post(`/api/approvals/${inv.approvals[0].id}/request-changes`).set(bearer(s)).send({ comment: 'Attach PO' })).status).toBe(200);
    expect((await getInvoice(s, inv.id)).status).toBe('MANUAL_REVIEW');
  });

  it('multi-level approval: manager first, then admin; admin cannot skip ahead; final approval completes', async () => {
    const s = await setup();
    const mgr = await addUser(s, 'FINANCE_MANAGER');
    const admin = await addUser(s, 'ADMIN');
    const rule = await api().post('/api/automation/rules').set(bearer(s)).send({
      name: 'Two level', trigger: 'INVOICE_PROCESSED', priority: 1,
      conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'greater_than_or_equal', value: 500000 }] },
      actions: [{ type: 'REQUIRE_MULTI_LEVEL_APPROVAL', levels: [{ role: 'FINANCE_MANAGER' }, { role: 'ADMIN' }] }],
    });
    expect(rule.status).toBe(201);
    const inv = await run(s, { total: 600000 });
    expect(inv.approvals.map((a: any) => [a.level, a.status])).toEqual([[1, 'PENDING'], [2, 'WAITING']]);
    const [l1, l2] = inv.approvals;
    expect((await api().post(`/api/approvals/${l2.id}/approve`).set(bearer(admin)).send({})).status).toBe(409); // level 2 not yet open
    expect((await api().post(`/api/approvals/${l1.id}/approve`).set(bearer(mgr)).send({})).status).toBe(200);
    expect((await getInvoice(s, inv.id)).status).toBe('PENDING_APPROVAL');
    expect((await api().post(`/api/approvals/${l2.id}/approve`).set(bearer(mgr)).send({})).status).toBe(403); // manager is not an admin
    expect((await api().post(`/api/approvals/${l2.id}/approve`).set(bearer(admin)).send({})).status).toBe(200);
    expect((await getInvoice(s, inv.id)).status).toBe('APPROVED');
    const adminNotes = (await api().get('/api/notifications').set(bearer(admin))).body.data.items;
    expect(adminNotes.some((n: any) => n.type === 'APPROVAL_REQUESTED' && n.invoiceId === inv.id)).toBe(true);
  });

  it('specific-user approver: only that user (or an owner) may decide', async () => {
    const s = await setup();
    const m1 = await addUser(s, 'FINANCE_MANAGER');
    const m2 = await addUser(s, 'FINANCE_MANAGER');
    await api().post('/api/automation/rules').set(bearer(s)).send({
      name: 'Named approver', trigger: 'INVOICE_PROCESSED', priority: 1,
      conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'greater_than', value: 30000 }] },
      actions: [{ type: 'REQUIRE_APPROVAL', userId: m1.userId }],
    });
    const inv = await run(s, { total: 40000 });
    expect((await api().post(`/api/approvals/${inv.approvals[0].id}/approve`).set(bearer(m2)).send({})).status).toBe(403);
    expect((await api().post(`/api/approvals/${inv.approvals[0].id}/approve`).set(bearer(m1)).send({})).status).toBe(200);
  });
});

describe('uploads and files', () => {
  it('rejects spoofed, oversized and unsupported uploads; file download needs auth and the right tenant', async () => {
    const s = await setup();
    const evil = await api().post('/api/invoices/upload').set(bearer(s)).attach('file', Buffer.from('MZ\x90 not a pdf'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(evil.status).toBe(400);
    expect(evil.body.error.code).toBe('FILE_CONTENT_MISMATCH');
    const exe = await api().post('/api/invoices/upload').set(bearer(s)).attach('file', Buffer.from('x'), { filename: 'a.exe', contentType: 'application/octet-stream' });
    expect(exe.body.error.code).toBe('FILE_TYPE_UNSUPPORTED');
    await prisma.organizationSettings.update({ where: { organizationId: s.orgId }, data: { maxUploadMb: 1 } });
    const big = Buffer.concat([pdf(mockData()), Buffer.alloc(1.2 * 1024 * 1024)]);
    expect((await api().post('/api/invoices/upload').set(bearer(s)).attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' })).status).toBeGreaterThanOrEqual(400);
    expect((await api().post('/api/invoices/upload').set(bearer(s))).body.error.code).toBe('FILE_MISSING');

    const ok = await upload(s, { total: 5000 });
    const id = ok.body.data.id;
    expect((await api().get(`/api/invoices/${id}/file`)).status).toBe(401);
    const file = await api().get(`/api/invoices/${id}/file`).set(bearer(s));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.fileUrl).toBe(`organizations/${s.orgId}/invoices/${id}/${row.fileUrl!.split('/').pop()}`);
  });

  it('CSV export includes invoice data only and neutralizes formula injection', async () => {
    const s = await setup();
    await run(s, { total: 5000, invoiceNumber: '=HYPERLINK("http://evil")' });
    const csv = (await api().get('/api/invoices/export.csv').set(bearer(s))).text;
    expect(csv.split('\n')[0]).toContain('Invoice Number');
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv.toLowerCase()).not.toMatch(/password|apikey|secret/);
  });
});
