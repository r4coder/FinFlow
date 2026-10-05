/**
 * Demo data seed. Idempotent: if the demo owner already exists nothing is changed.
 *
 * Invoices are NOT inserted as canned rows. Each one is generated as a document and pushed through the real
 * pipeline (mock AI -> validation -> duplicate/anomaly detection -> rule engine -> approvals/notifications/audit),
 * so rule executions, approvals, notifications and audit logs in the demo are genuine outputs of the system.
 * All names and numbers are fictional.
 */
process.env.QUEUE_MODE = 'inline'; // process synchronously inside the seed (no worker needed)

const DEMO_EMAIL = 'admin@invoiceflow.demo';
const DEMO_PASSWORD = 'Demo@12345';

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VENDORS = [
  { name: 'Northwind Logistics Pvt Ltd', industry: 'Logistics', group: 'preferred', taxId: '29AABCN1234F1Z5', terms: 'Net 30' },
  { name: 'Apex Office Supplies', industry: 'Office Supplies', group: 'preferred', taxId: '27AAFCA9876K1ZB', terms: 'Net 15' },
  { name: 'BlueOrbit Cloud Services', industry: 'IT', group: 'strategic', taxId: '36AAECB4567M1Z2', terms: 'Net 30' },
  { name: 'Greenfield Facilities Co', industry: 'Facilities', group: 'standard', taxId: '33AAACG2345H1ZP', terms: 'Net 45' },
  { name: 'Quantum Print & Packaging', industry: 'Manufacturing', group: 'standard', taxId: '07AAHCQ7788L1Z9', terms: 'Net 30' },
  { name: 'Sunrise Catering Services', industry: 'Hospitality', group: 'standard', taxId: '24AAJCS5566P1Z3', terms: 'Net 7' },
  { name: 'Meridian Legal Associates', industry: 'Professional Services', group: 'preferred', taxId: '19AAKCM3344Q1Z8', terms: 'Net 30' },
  { name: 'Crescent Electricals', industry: 'Utilities', group: 'standard', taxId: '32AABCC9911R1Z4', terms: 'Net 30' },
  { name: 'Zenith Staffing Solutions', industry: 'HR Services', group: 'strategic', taxId: '29AAFCZ7722S1Z6', terms: 'Net 30' },
  { name: 'Orchid Marketing Studio', industry: 'Marketing', group: 'standard', taxId: '27AAICO6633T1Z1', terms: 'Net 20' },
];

const ITEMS: Record<string, string[]> = {
  Logistics: ['Freight - Hyderabad to Pune', 'Warehouse handling', 'Last-mile delivery batch', 'Cold-chain surcharge', 'Customs documentation'],
  'Office Supplies': ['A4 paper (cartons)', 'Toner cartridges', 'Ergonomic chairs', 'Whiteboard markers', 'Filing cabinets'],
  IT: ['Cloud compute (monthly)', 'Managed database', 'Support plan - premium', 'Object storage (TB)', 'Security monitoring'],
  Facilities: ['Housekeeping - monthly', 'HVAC maintenance', 'Pest control', 'Landscaping', 'Security guards'],
  Manufacturing: ['Corrugated boxes', 'Custom label printing', 'Shrink wrap rolls', 'Pallets', 'Brochure printing'],
  Hospitality: ['Lunch catering (per head)', 'Tea & snacks service', 'Event setup', 'Beverage station', 'Dinner buffet'],
  'Professional Services': ['Contract review', 'Retainer - monthly', 'Compliance advisory', 'Trademark filing', 'Dispute consultation'],
  Utilities: ['Electrical panel upgrade', 'Cabling & conduits', 'Generator service', 'Lighting retrofit', 'Preventive maintenance'],
  'HR Services': ['Contract staff - month', 'Recruitment fee', 'Background verification', 'Payroll processing', 'Training session'],
  Marketing: ['Campaign design', 'Social media management', 'Photography shoot', 'Print collateral', 'Video editing'],
};

interface Spec {
  v: number;
  target: number;
  age: number; // days ago
  po?: boolean;
  confidence?: number;
  taxMismatch?: boolean;
  dupOf?: number; // index of spec to copy business key from
  unknownVendor?: string;
  decide?: 'approve' | 'reject' | 'level1';
  by?: 'owner' | 'clerk';
}

const SPECS: Spec[] = [
  // 12 small, clean invoices -> auto-approved by "Low Value Auto Approval"
  { v: 1, target: 3200, age: 175 }, { v: 0, target: 7400, age: 160 }, { v: 4, target: 5200, age: 150 }, { v: 5, target: 2600, age: 140 },
  { v: 9, target: 8800, age: 128 }, { v: 3, target: 6100, age: 118 }, { v: 1, target: 4300, age: 104 }, { v: 7, target: 9300, age: 92 },
  { v: 2, target: 5600, age: 80 }, { v: 0, target: 3900, age: 66 }, { v: 4, target: 7100, age: 41 }, { v: 9, target: 2800, age: 20 },
  // 8 mid-value -> finance manager approval
  { v: 2, target: 24000, age: 170, decide: 'approve' }, { v: 6, target: 56000, age: 135, decide: 'approve' }, { v: 8, target: 41000, age: 110, decide: 'approve' },
  { v: 3, target: 18500, age: 95, decide: 'reject' }, { v: 0, target: 72000, age: 25 }, { v: 2, target: 36000, age: 12 }, { v: 8, target: 15500, age: 6 }, { v: 6, target: 88000, age: 3 },
  // 2 very high -> admin approval
  { v: 2, target: 185000, age: 60, decide: 'approve' }, { v: 4, target: 142000, age: 9 },
  // 2 duplicates of earlier invoices
  { v: 0, target: 0, age: 54, dupOf: 12 }, { v: 2, target: 0, age: 4, dupOf: 0 },
  // 2 missing PO on high-value invoices -> manual review
  { v: 8, target: 64000, age: 33, po: false }, { v: 6, target: 38000, age: 8, po: false },
  // arithmetic mismatch, low AI confidence, unknown vendor, multi-level
  { v: 7, target: 21000, age: 17, taxMismatch: true },
  { v: 5, target: 4100, age: 11, confidence: 0.52 },
  { v: 0, target: 5400, age: 2, unknownVendor: 'Lotus Event Rentals LLP' },
  { v: 2, target: 690000, age: 14, decide: 'level1', by: 'owner' },
];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  const { prisma } = await import('../db');
  const { register } = await import('../services/auth.service');
  const { hashPassword } = await import('../security/password');
  const { createRule } = await import('../rules/rule.service');
  const { RULE_TEMPLATES } = await import('../rules/templates');
  const { uploadInvoice } = await import('../invoices/invoice.service');
  const { decideApproval } = await import('../approvals/approval.service');

  if (await prisma.user.findUnique({ where: { email: DEMO_EMAIL } })) {
    console.log('[seed] demo data already present — nothing to do');
    return;
  }
  console.log('[seed] creating demo organization...');
  const reg = await register({ fullName: 'Rahul Verma', email: DEMO_EMAIL, password: DEMO_PASSWORD, confirmPassword: DEMO_PASSWORD, companyName: 'Demo Industries Pvt Ltd', industry: 'Manufacturing', companySize: '51-200' });
  const orgId = reg.user.organization.id;
  const owner = { userId: reg.user.id, organizationId: orgId, role: 'OWNER' as const, email: DEMO_EMAIL, fullName: 'Rahul Verma' };

  const mk = async (email: string, fullName: string, role: 'FINANCE_MANAGER' | 'FINANCE_USER') => {
    const u = await prisma.user.create({ data: { email, fullName, passwordHash: await hashPassword(DEMO_PASSWORD) } });
    await prisma.organizationMember.create({ data: { organizationId: orgId, userId: u.id, role } });
    return { userId: u.id, organizationId: orgId, role, email, fullName };
  };
  const manager = await mk('manager@invoiceflow.demo', 'Priya Nair', 'FINANCE_MANAGER');
  const clerk = await mk('clerk@invoiceflow.demo', 'Arjun Rao', 'FINANCE_USER');

  // Also enable the multi-level template so a >= 500,000 invoice demonstrates a 2-step chain.
  const tpl = RULE_TEMPLATES.find((t) => t.key === 'multi-level-very-high')!;
  await createRule(orgId, owner, { name: tpl.name, description: tpl.description, enabled: true, priority: tpl.priority, trigger: tpl.trigger, conditions: tpl.conditions, actions: tpl.actions, templateKey: tpl.key });

  for (const v of VENDORS) {
    await prisma.vendor.create({
      data: { organizationId: orgId, name: v.name, normalizedName: v.name.toLowerCase().replace(/\s+/g, ' '), industry: v.industry, group: v.group, taxId: v.taxId, paymentTerms: v.terms, email: `billing@${v.name.split(' ')[0].toLowerCase()}.example`, verified: true },
    });
  }

  const rand = rng(20261004);
  const builtByIndex: Record<number, any> = {};
  const order = SPECS.map((s, i) => ({ s, i })).sort((a, b) => b.s.age - a.s.age); // oldest first => chronological processing
  let lineCount = 0;
  const created: { id: string; spec: Spec; ts: Date }[] = [];

  for (const { s, i } of order) {
    const vendor = s.unknownVendor ? { name: s.unknownVendor, industry: 'Hospitality', taxId: null, terms: 'Net 30' } : VENDORS[s.v];
    const day = new Date(Date.now() - s.age * 86400000);
    const invoiceDate = day.toISOString().slice(0, 10);
    const dueDate = new Date(day.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    let data: any;
    if (s.dupOf !== undefined) {
      // Same vendor + invoice number + date + total as an earlier invoice (different file bytes) => duplicate detection fires.
      const orig = builtByIndex[s.dupOf];
      data = { ...orig, confidence: 0.94 };
    } else {
      const n = 3 + Math.floor(rand() * 3);
      const catalog = ITEMS[vendor.industry as string] ?? ITEMS.IT;
      const weights = Array.from({ length: n }, () => 0.5 + rand());
      const wsum = weights.reduce((a, b) => a + b, 0);
      const subtotalTarget = s.target / 1.18;
      const lineItems = weights.map((w, k) => {
        const qty = 1 + Math.floor(rand() * 9);
        const unit = round2((subtotalTarget * (w / wsum)) / qty);
        const lineTotal = round2(qty * unit);
        return { description: catalog[k % catalog.length], quantity: qty, unitPrice: unit, taxRate: 18, taxAmount: round2(lineTotal * 0.18), lineTotal };
      });
      const subtotal = round2(lineItems.reduce((a, l) => a + l.lineTotal, 0));
      const tax = round2(lineItems.reduce((a, l) => a + l.taxAmount, 0));
      data = {
        invoiceNumber: `INV-${2000 + i}`,
        vendorName: vendor.name,
        vendorTaxId: vendor.taxId,
        invoiceDate,
        dueDate,
        currency: 'INR',
        subtotal,
        tax,
        total: s.taxMismatch ? round2(subtotal + tax + 1850) : round2(subtotal + tax),
        purchaseOrderNumber: s.po === false ? null : `PO-${4000 + i}`,
        paymentTerms: (vendor as any).terms ?? 'Net 30',
        lineItems,
        confidence: s.confidence ?? 0.9 + Math.floor(rand() * 9) / 100,
      };
      lineCount += n;
    }
    if (s.dupOf !== undefined) lineCount += data.lineItems.length;
    builtByIndex[i] = data;

    const nonce = `seed-${i}`;
    const buffer = Buffer.from(`%PDF-1.4\n%MOCKDATA:${JSON.stringify(data)}\n%${nonce}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
    const uploader = s.by === 'owner' ? owner : clerk;
    const inv = await uploadInvoice(uploader, { originalname: `${data.vendorName.split(' ')[0].toLowerCase()}-${data.invoiceNumber}.pdf`, mimetype: 'application/pdf', buffer, size: buffer.length });
    created.push({ id: inv.id, spec: s, ts: new Date(day.getTime() + 36e5 * 10) });
  }

  // human decisions on some approvals (so the demo has approved / rejected / pending items)
  for (const c of created) {
    if (!c.spec.decide) continue;
    const approvals = await prisma.approval.findMany({ where: { invoiceId: c.id, status: 'PENDING' }, orderBy: { level: 'asc' } });
    if (!approvals.length) continue;
    const actorFor = (role: string | null) => (role === 'ADMIN' || role === 'OWNER' ? owner : manager);
    if (c.spec.decide === 'approve') await decideApproval(actorFor(approvals[0].approverRole), approvals[0].id, 'approve', 'Verified against PO and delivery note');
    if (c.spec.decide === 'reject') await decideApproval(manager, approvals[0].id, 'reject', 'Billed quantity does not match goods received');
    if (c.spec.decide === 'level1') await decideApproval(manager, approvals[0].id, 'approve', 'Level 1 OK — forwarding to admin');
  }

  // Backdate timestamps so charts/history look like real months of activity (processing itself ran just now).
  for (const c of created) {
    const ts = c.ts;
    await prisma.invoice.update({ where: { id: c.id }, data: { createdAt: ts, processedAt: ts } });
    await prisma.businessRuleExecution.updateMany({ where: { invoiceId: c.id }, data: { startedAt: ts, completedAt: new Date(ts.getTime() + 40) } });
    await prisma.auditLog.updateMany({ where: { invoiceId: c.id }, data: { createdAt: ts } });
    await prisma.notification.updateMany({ where: { invoiceId: c.id }, data: { createdAt: ts } });
    await prisma.approval.updateMany({ where: { invoiceId: c.id }, data: { createdAt: ts } });
    await prisma.approval.updateMany({ where: { invoiceId: c.id, decidedAt: { not: null } }, data: { decidedAt: new Date(ts.getTime() + 3 * 36e5) } });
    await prisma.aIProcessingJob.updateMany({ where: { invoiceId: c.id }, data: { startedAt: ts, completedAt: ts } });
  }
  // Leave some notifications unread, mark older ones read
  await prisma.notification.updateMany({ where: { organizationId: orgId, createdAt: { lt: new Date(Date.now() - 7 * 86400000) } }, data: { read: true } });
  await prisma.onboarding.update({ where: { organizationId: orgId }, data: { firstInvoice: true, rulesReviewed: true } });

  const counts = {
    users: await prisma.organizationMember.count({ where: { organizationId: orgId } }),
    vendors: await prisma.vendor.count({ where: { organizationId: orgId } }),
    invoices: await prisma.invoice.count({ where: { organizationId: orgId } }),
    lineItems: await prisma.invoiceLineItem.count({ where: { invoice: { organizationId: orgId } } }),
    rules: await prisma.businessRule.count({ where: { organizationId: orgId } }),
    executions: await prisma.businessRuleExecution.count({ where: { organizationId: orgId } }),
    approvals: await prisma.approval.count({ where: { organizationId: orgId } }),
    notifications: await prisma.notification.count({ where: { organizationId: orgId } }),
    auditLogs: await prisma.auditLog.count({ where: { organizationId: orgId } }),
  };
  console.log('[seed] done', counts, `(line items generated: ${lineCount})`);
  console.log(`[seed] demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import('../db');
    await prisma.$disconnect();
  });
