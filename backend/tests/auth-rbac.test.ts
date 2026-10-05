import { describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { addUser, api, bearer, createVendor, getInvoice, registerOrg, upload } from './helpers';

describe('registration', () => {
  it('creates organization, owner, settings, default rules and an audit entry atomically', async () => {
    const s = await registerOrg();
    const me = await api().get('/api/auth/me').set(bearer(s));
    expect(me.body.data.role).toBe('OWNER');
    expect(me.body.data.permissions).toContain('users:manage');
    const rules = await prisma.businessRule.findMany({ where: { organizationId: s.orgId } });
    expect(rules.length).toBe(7);
    expect(rules.every((r) => r.version === 1)).toBe(true);
    expect(await prisma.organizationSettings.count({ where: { organizationId: s.orgId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: s.orgId, action: 'organization.created' } })).toBe(1);
    expect(await prisma.businessRuleVersion.count({ where: { organizationId: s.orgId } })).toBe(7);
  });

  it('hashes passwords, rejects duplicates, weak passwords and mismatched confirmation', async () => {
    const s = await registerOrg();
    const user = await prisma.user.findUnique({ where: { id: s.userId } });
    expect(user!.passwordHash).not.toContain('Passw0rd');
    expect(user!.passwordHash.startsWith('$2')).toBe(true);
    const dup = await api().post('/api/auth/register').send({ fullName: 'X Y', email: s.email, password: 'Passw0rd!x', confirmPassword: 'Passw0rd!x', companyName: 'Dup Co' });
    expect(dup.status).toBe(409);
    const weak = await api().post('/api/auth/register').send({ fullName: 'X Y', email: 'weak@test.dev', password: 'short', confirmPassword: 'short', companyName: 'Weak Co' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    const mism = await api().post('/api/auth/register').send({ fullName: 'X Y', email: 'm@test.dev', password: 'Passw0rd!x', confirmPassword: 'Different1x', companyName: 'M Co' });
    expect(mism.status).toBe(400);
  });
});

describe('login, refresh, logout', () => {
  it('logs in, rejects bad credentials with a generic message, and rotates refresh tokens', async () => {
    const s = await registerOrg();
    expect((await api().post('/api/auth/login').send({ email: s.email, password: 'wrong-Pass1' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: 'nobody@test.dev', password: 'Passw0rd!x' })).body.error.message).toBe('Invalid email or password');

    const login = await api().post('/api/auth/login').send({ email: s.email, password: 'Passw0rd!x' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'] as unknown as string[];
    expect(cookie[0]).toMatch(/HttpOnly/);
    expect(login.body.data.refreshToken).toBeUndefined(); // refresh token never in the JSON body

    const r1 = await api().post('/api/auth/refresh').set('Cookie', cookie);
    expect(r1.status).toBe(200);
    const r2 = await api().post('/api/auth/refresh').set('Cookie', cookie); // reuse of the rotated token
    expect(r2.status).toBe(401);
    expect(r2.body.error.code).toBe('REFRESH_REUSE');

    const login2 = await api().post('/api/auth/login').send({ email: s.email, password: 'Passw0rd!x' });
    const c2 = login2.headers['set-cookie'] as unknown as string[];
    await api().post('/api/auth/logout').set('Cookie', c2);
    expect((await api().post('/api/auth/refresh').set('Cookie', c2)).status).toBe(401);
  });

  it('protects routes and rejects garbage tokens', async () => {
    expect((await api().get('/api/invoices')).status).toBe(401);
    expect((await api().get('/api/invoices').set(bearer('not.a.jwt'))).status).toBe(401);
  });

  it('forgot/reset password invalidates the old password and sessions', async () => {
    const s = await registerOrg();
    const f = await api().post('/api/auth/forgot-password').send({ email: s.email });
    const token = new URL(f.body.data.devResetLink).searchParams.get('token')!;
    expect((await api().post('/api/auth/reset-password').send({ token, password: 'NewPassw0rd!' })).status).toBe(200);
    expect((await api().post('/api/auth/reset-password').send({ token, password: 'Another1Pass' })).status).toBe(400); // single use
    expect((await api().post('/api/auth/login').send({ email: s.email, password: 'Passw0rd!x' })).status).toBe(401);
    expect((await api().post('/api/auth/login').send({ email: s.email, password: 'NewPassw0rd!' })).status).toBe(200);
    const unknown = await api().post('/api/auth/forgot-password').send({ email: 'ghost@test.dev' });
    expect(unknown.status).toBe(200); // does not reveal whether the account exists
    expect(unknown.body.data.devResetLink).toBeUndefined();
  });
});

describe('RBAC (enforced on the backend)', () => {
  it('enforces per-role permissions', async () => {
    const owner = await registerOrg();
    const viewer = await addUser(owner, 'VIEWER');
    const finUser = await addUser(owner, 'FINANCE_USER');
    const finMgr = await addUser(owner, 'FINANCE_MANAGER');
    const admin = await addUser(owner, 'ADMIN');

    expect((await api().get('/api/invoices').set(bearer(viewer))).status).toBe(200);
    expect((await upload(viewer, {})).status).toBe(403);
    expect((await api().post('/api/vendors').set(bearer(viewer)).send({ name: 'V' })).status).toBe(403);
    expect((await api().post('/api/automation/rules').set(bearer(viewer)).send({})).status).toBe(403);
    expect((await api().get('/api/audit-logs').set(bearer(viewer))).status).toBe(403);

    expect((await upload(finUser, {})).status).toBe(201);
    expect((await api().post('/api/automation/rules').set(bearer(finUser)).send({})).status).toBe(403); // can't manage rules
    expect((await api().put('/api/settings/ai').set(bearer(finMgr)).send({ mode: 'MOCK' })).status).toBe(403);
    expect((await api().put('/api/settings/ai').set(bearer(admin)).send({ mode: 'MOCK' })).status).toBe(200);
    expect((await api().post('/api/users').set(bearer(finMgr)).send({ fullName: 'N N', email: 'n@test.dev', password: 'Passw0rd!x', role: 'VIEWER' })).status).toBe(403);
  });

  it('a finance user cannot approve; a finance manager can', async () => {
    const owner = await registerOrg();
    await createVendor(owner, 'Acme Test Supplies');
    const finUser = await addUser(owner, 'FINANCE_USER');
    const finMgr = await addUser(owner, 'FINANCE_MANAGER');
    const up = await upload(finUser, { total: 20000 }); // 10k-100k -> manager approval
    const inv = await getInvoice(owner, up.body.data.id);
    expect(inv.status).toBe('PENDING_APPROVAL');
    const approvalId = inv.approvals[0].id;
    expect((await api().post(`/api/approvals/${approvalId}/approve`).set(bearer(finUser)).send({})).status).toBe(403);
    expect((await api().post(`/api/approvals/${approvalId}/approve`).set(bearer(finMgr)).send({})).status).toBe(200);
  });

  it('role guards: cannot change own role, cannot demote the last owner, admin cannot grant OWNER', async () => {
    const owner = await registerOrg();
    const admin = await addUser(owner, 'ADMIN');
    expect((await api().patch(`/api/users/${owner.userId}/role`).set(bearer(owner)).send({ role: 'ADMIN' })).status).toBe(400);
    expect((await api().patch(`/api/users/${admin.userId}/role`).set(bearer(admin)).send({ role: 'OWNER' })).status).toBe(400);
    const viewer = await addUser(owner, 'VIEWER');
    expect((await api().patch(`/api/users/${viewer.userId}/role`).set(bearer(admin)).send({ role: 'OWNER' })).status).toBe(403);
    expect((await api().patch(`/api/users/${viewer.userId}/role`).set(bearer(owner)).send({ role: 'FINANCE_USER' })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { organizationId: owner.orgId, action: 'user.role_changed' } })).toBe(1);
  });
});

describe('multi-tenancy isolation', () => {
  it("organization B cannot read or touch organization A's data", async () => {
    const a = await registerOrg();
    const b = await registerOrg();
    await createVendor(a, 'Acme Test Supplies');
    const up = await upload(a, { total: 20000 });
    const invId = up.body.data.id;
    const detailA = await getInvoice(a, invId);
    const ruleA = (await api().get('/api/automation/rules').set(bearer(a))).body.data.items[0];
    const vendorA = (await api().get('/api/vendors').set(bearer(a))).body.data.items[0];

    // invoices
    expect((await api().get(`/api/invoices/${invId}`).set(bearer(b))).status).toBe(404);
    expect((await api().get(`/api/invoices/${invId}/file`).set(bearer(b))).status).toBe(404);
    expect((await api().patch(`/api/invoices/${invId}`).set(bearer(b)).send({ invoiceNumber: 'HACK' })).status).toBe(404);
    expect((await api().post(`/api/invoices/${invId}/reprocess`).set(bearer(b)).send({})).status).toBe(404);
    expect((await api().get('/api/invoices').set(bearer(b))).body.data.items).toHaveLength(0);
    expect((await api().get('/api/invoices/export.csv').set(bearer(b))).text.split('\n')).toHaveLength(1);
    // rules
    expect((await api().get(`/api/automation/rules/${ruleA.id}`).set(bearer(b))).status).toBe(404);
    expect((await api().patch(`/api/automation/rules/${ruleA.id}`).set(bearer(b)).send({ enabled: false })).status).toBe(404);
    expect((await api().delete(`/api/automation/rules/${ruleA.id}`).set(bearer(b))).status).toBe(404);
    expect((await api().post(`/api/automation/rules/${ruleA.id}/test`).set(bearer(b)).send({ invoiceId: invId })).status).toBe(404);
    expect((await api().get(`/api/automation/rules/${ruleA.id}/versions`).set(bearer(b))).status).toBe(404);
    const bRules = (await api().get('/api/automation/rules').set(bearer(b))).body.data.items;
    expect(bRules.map((r: any) => r.id)).not.toContain(ruleA.id);
    // dry-run of B's own rule against A's invoice
    const bRule = bRules[0];
    expect((await api().post(`/api/automation/rules/${bRule.id}/test`).set(bearer(b)).send({ invoiceId: invId })).status).toBe(404);
    // approvals, vendors, executions, audit, notifications
    const approvalA = detailA.approvals[0];
    expect((await api().post(`/api/approvals/${approvalA.id}/approve`).set(bearer(b)).send({})).status).toBe(404);
    expect((await api().get(`/api/vendors/${vendorA.id}`).set(bearer(b))).status).toBe(404);
    expect((await api().get('/api/vendors').set(bearer(b))).body.data.items).toHaveLength(0);
    expect((await api().get('/api/automation/executions').set(bearer(b))).body.data.items).toHaveLength(0);
    const execA = detailA.executions[0];
    expect((await api().get(`/api/automation/executions/${execA.id}`).set(bearer(b))).status).toBe(404);
    expect((await api().get('/api/audit-logs').set(bearer(b)).query({ invoiceId: invId })).body.data.items).toHaveLength(0);
    // ignores an organizationId smuggled in by the client
    const smuggled = await api().get('/api/invoices').set(bearer(b)).query({ organizationId: a.orgId });
    expect(smuggled.body.data.items).toHaveLength(0);
    // A's data is untouched
    expect((await getInvoice(a, invId)).invoiceNumber).toBe(detailA.invoiceNumber);
  });

  it("a rule that references another organization's user is rejected", async () => {
    const a = await registerOrg();
    const b = await registerOrg();
    const res = await api().post('/api/automation/rules').set(bearer(b)).send({
      name: 'Evil', trigger: 'INVOICE_PROCESSED', priority: 1,
      conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'greater_than', value: 1 }] },
      actions: [{ type: 'SEND_NOTIFICATION', recipient: 'USER', userId: a.userId }],
    });
    expect(res.status).toBe(400);
  });

  it('companies have independent rules (A auto-approves < 10k, B < 25k)', async () => {
    const a = await registerOrg();
    const b = await registerOrg();
    await createVendor(a, 'Acme Test Supplies');
    await createVendor(b, 'Acme Test Supplies');
    const bRule = (await api().get('/api/automation/rules').set(bearer(b))).body.data.items.find((r: any) => r.templateKey === 'low-value-auto-approval');
    const patched = await api().patch(`/api/automation/rules/${bRule.id}`).set(bearer(b)).send({
      conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'less_than', value: 25000 }, { field: 'invoice.riskLevel', operator: 'equals', value: 'LOW' }] },
    });
    expect(patched.status).toBe(200);
    // the 10k-100k manager-approval rule (priority 6) still beats auto-approve (7) for B, so move auto-approve first
    await api().patch(`/api/automation/rules/${bRule.id}`).set(bearer(b)).send({ priority: 5 });
    const ia = await getInvoice(a, (await upload(a, { total: 15000 })).body.data.id);
    const ib = await getInvoice(b, (await upload(b, { total: 15000 })).body.data.id);
    expect(ia.status).toBe('PENDING_APPROVAL');
    expect(ib.status).toBe('APPROVED');
    expect(ib.autoApproved).toBe(true);
  });
});
