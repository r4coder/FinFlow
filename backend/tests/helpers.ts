import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';

export const app = createApp();
export const api = () => request(app);

export interface Session {
  token: string;
  orgId: string;
  userId: string;
  email: string;
  cookies: string[];
}

export async function registerOrg(overrides: Record<string, unknown> = {}): Promise<Session> {
  const email = `owner-${randomUUID().slice(0, 8)}@test.dev`;
  const res = await api()
    .post('/api/auth/register')
    .send({ fullName: 'Test Owner', email, password: 'Passw0rd!x', confirmPassword: 'Passw0rd!x', companyName: `Co ${randomUUID().slice(0, 6)}`, industry: 'Retail', companySize: '11-50', ...overrides });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, orgId: res.body.data.user.organization.id, userId: res.body.data.user.id, email, cookies: res.headers['set-cookie'] as unknown as string[] };
}

export const bearer = (s: Session | string) => ({ Authorization: `Bearer ${typeof s === 'string' ? s : s.token}` });

export async function addUser(owner: Session, role: string): Promise<Session> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.dev`;
  const created = await api().post('/api/users').set(bearer(owner)).send({ fullName: `${role} User`, email, password: 'Passw0rd!x', role });
  if (created.status !== 201) throw new Error(`addUser failed: ${JSON.stringify(created.body)}`);
  const login = await api().post('/api/auth/login').send({ email, password: 'Passw0rd!x' });
  return { token: login.body.data.accessToken, orgId: owner.orgId, userId: created.body.data.id, email, cookies: login.headers['set-cookie'] as unknown as string[] };
}

export interface InvoiceSpec {
  invoiceNumber?: string;
  vendorName?: string;
  vendorTaxId?: string | null;
  total?: number;
  tax?: number;
  subtotal?: number;
  po?: string | null;
  confidence?: number;
  invoiceDate?: string;
  dueDate?: string;
  currency?: string;
  lineTotalOverride?: number;
}

export function mockData(spec: InvoiceSpec = {}) {
  const total = spec.total ?? 5000;
  const tax = spec.tax ?? 0;
  const subtotal = spec.subtotal ?? total - tax;
  return {
    invoiceNumber: spec.invoiceNumber ?? `INV-${randomUUID().slice(0, 8)}`,
    vendorName: spec.vendorName ?? 'Acme Test Supplies',
    vendorTaxId: spec.vendorTaxId === undefined ? null : spec.vendorTaxId,
    invoiceDate: spec.invoiceDate ?? '2026-09-01',
    dueDate: spec.dueDate ?? '2026-10-01',
    currency: spec.currency ?? 'INR',
    subtotal,
    tax,
    total,
    purchaseOrderNumber: spec.po === undefined ? 'PO-1001' : spec.po,
    paymentTerms: 'Net 30',
    lineItems: [{ description: 'Services', quantity: 1, unitPrice: subtotal, taxRate: null, taxAmount: null, lineTotal: spec.lineTotalOverride ?? subtotal }],
    confidence: spec.confidence ?? 0.95,
  };
}

/** A structurally valid PDF carrying a MOCKDATA marker that the MOCK AI provider turns into the extraction. Unique bytes per call. */
export function pdf(data: object, nonce: string = randomUUID()): Buffer {
  return Buffer.from(`%PDF-1.4\n%MOCKDATA:${JSON.stringify(data)}\n%nonce:${nonce}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

export async function upload(s: Session | string, spec: InvoiceSpec | object, opts: { nonce?: string; raw?: boolean } = {}) {
  const data = opts.raw ? spec : mockData(spec as InvoiceSpec);
  const res = await api().post('/api/invoices/upload').set(bearer(s)).attach('file', pdf(data, opts.nonce), { filename: 'invoice.pdf', contentType: 'application/pdf' });
  return res;
}

export async function getInvoice(s: Session | string, id: string) {
  const r = await api().get(`/api/invoices/${id}`).set(bearer(s));
  return r.body.data;
}

export async function createVendor(s: Session, name: string) {
  const r = await api().post('/api/vendors').set(bearer(s)).send({ name });
  return r.body.data;
}
