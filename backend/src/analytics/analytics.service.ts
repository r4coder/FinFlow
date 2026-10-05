import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { num, round2 } from '../utils/money';

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

interface MonthRow {
  month: Date;
  count: bigint;
  spend: Prisma.Decimal | null;
  auto: bigint;
  processed: bigint;
  avg_ms: number | null;
}

export async function dashboard(organizationId: string) {
  const [byStatus, byRisk, processed, auto, dupes, spendAgg, totalAgg] = await Promise.all([
    prisma.invoice.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    prisma.invoice.groupBy({ by: ['riskLevel'], where: { organizationId, riskLevel: { not: null } }, _count: { _all: true } }),
    prisma.invoice.count({ where: { organizationId, completedRun: { gt: 0 } } }),
    prisma.invoice.count({ where: { organizationId, completedRun: { gt: 0 }, autoApproved: true } }),
    prisma.invoice.count({ where: { organizationId, duplicateDetected: true } }),
    prisma.invoice.aggregate({ where: { organizationId, status: { in: ['APPROVED', 'PAID'] } }, _sum: { total: true } }),
    prisma.invoice.aggregate({ where: { organizationId, total: { not: null } }, _sum: { total: true }, _avg: { total: true } }),
  ]);
  const s = Object.fromEntries(byStatus.map((x) => [x.status, x._count._all])) as Record<string, number>;
  const totalInvoices = byStatus.reduce((a, x) => a + x._count._all, 0);
  const approved = (s.APPROVED ?? 0) + (s.PAID ?? 0);
  const rejected = s.REJECTED ?? 0;
  const exceptions = (s.MANUAL_REVIEW ?? 0) + (s.FAILED ?? 0);

  const months = await prisma.$queryRaw<MonthRow[]>`
    SELECT date_trunc('month', COALESCE("invoiceDate"::timestamp, "createdAt")) AS month,
           COUNT(*) AS count,
           COALESCE(SUM("total"), 0) AS spend,
           COUNT(*) FILTER (WHERE "autoApproved" = true AND "completedRun" > 0) AS auto,
           COUNT(*) FILTER (WHERE "completedRun" > 0) AS processed,
           AVG("processingMs") AS avg_ms
    FROM "Invoice"
    WHERE "organizationId" = ${organizationId}
      AND COALESCE("invoiceDate"::timestamp, "createdAt") >= date_trunc('month', now()) - interval '11 months'
    GROUP BY 1 ORDER BY 1`;
  const monthly = months.map((m) => ({
    month: m.month.toISOString().slice(0, 7),
    invoices: Number(m.count),
    spend: round2(num(m.spend) ?? 0),
    automationRate: pct(Number(m.auto), Number(m.processed)),
    avgProcessingMs: m.avg_ms === null ? null : Math.round(Number(m.avg_ms)),
  }));

  const vendorSpendRaw = await prisma.invoice.groupBy({ by: ['vendorId'], where: { organizationId, vendorId: { not: null }, total: { not: null } }, _sum: { total: true }, _count: { _all: true }, orderBy: { _sum: { total: 'desc' } }, take: 8 });
  const vendors = await prisma.vendor.findMany({ where: { id: { in: vendorSpendRaw.map((v) => v.vendorId!) } }, select: { id: true, name: true } });
  const vName = new Map(vendors.map((v) => [v.id, v.name]));

  const procAgg = await prisma.invoice.aggregate({ where: { organizationId, processingMs: { not: null } }, _avg: { processingMs: true } });
  const onboarding = await prisma.onboarding.findUnique({ where: { organizationId } });

  return {
    kpis: {
      invoicesProcessed: processed,
      totalInvoices,
      pendingApproval: s.PENDING_APPROVAL ?? 0,
      approved,
      rejected,
      exceptions,
      automationRate: pct(auto, processed),
      manualReviewRate: processed ? round2(100 - pct(auto, processed)) : 0,
      totalSpend: num(spendAgg._sum.total) ?? 0,
      potentialDuplicates: dupes,
    },
    metrics: {
      totalInvoiceValue: num(totalAgg._sum.total) ?? 0,
      averageInvoiceValue: round2(num(totalAgg._avg.total) ?? 0),
      approvalRate: pct(approved, approved + rejected),
      rejectionRate: pct(rejected, approved + rejected),
      exceptionRate: pct(exceptions, totalInvoices),
      duplicateRate: pct(dupes, totalInvoices),
      averageProcessingMs: Math.round(procAgg._avg.processingMs ?? 0),
    },
    charts: {
      monthly,
      statusBreakdown: byStatus.map((x) => ({ status: x.status, count: x._count._all })),
      riskDistribution: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((r) => ({ risk: r, count: byRisk.find((x) => x.riskLevel === r)?._count._all ?? 0 })),
      vendorSpend: vendorSpendRaw.map((v) => ({ vendor: vName.get(v.vendorId!) ?? 'Unknown', spend: num(v._sum.total) ?? 0, invoices: v._count._all })),
    },
    onboarding,
  };
}

export async function automation(organizationId: string) {
  const [rules, grouped, results, perDay, totals] = await Promise.all([
    prisma.businessRule.findMany({ where: { organizationId, deletedAt: null }, select: { id: true, name: true, enabled: true, priority: true } }),
    prisma.businessRuleExecution.groupBy({ by: ['ruleId'], where: { organizationId, matched: true }, _count: { _all: true }, _avg: { durationMs: true } }),
    prisma.businessRuleExecution.groupBy({ by: ['ruleId', 'result'], where: { organizationId, matched: true }, _count: { _all: true } }),
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "startedAt") AS day, COUNT(*) AS count FROM "BusinessRuleExecution"
      WHERE "organizationId" = ${organizationId} AND matched = true AND "startedAt" >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    prisma.businessRuleExecution.groupBy({ by: ['matched'], where: { organizationId }, _count: { _all: true } }),
  ]);
  const stats = rules.map((r) => {
    const g = grouped.find((x) => x.ruleId === r.id);
    const rs = results.filter((x) => x.ruleId === r.id);
    const successful = rs.filter((x) => x.result === 'SUCCESS').reduce((a, x) => a + x._count._all, 0);
    const failed = rs.filter((x) => x.result === 'FAILED' || x.result === 'PARTIAL_FAILURE').reduce((a, x) => a + x._count._all, 0);
    return { ruleId: r.id, name: r.name, enabled: r.enabled, priority: r.priority, executions: g?._count._all ?? 0, successful, failed, avgDurationMs: Math.round((g?._avg.durationMs ?? 0) * 10) / 10 };
  });
  const dash = await dashboard(organizationId);
  return {
    mostTriggered: [...stats].sort((a, b) => b.executions - a.executions).slice(0, 10),
    rules: stats,
    executionsPerDay: perDay.map((d) => ({ day: d.day.toISOString().slice(0, 10), count: Number(d.count) })),
    totals: { evaluated: totals.reduce((a, x) => a + x._count._all, 0), matched: totals.find((x) => x.matched)?._count._all ?? 0 },
    automationRate: dash.kpis.automationRate,
    manualReviewRate: dash.kpis.manualReviewRate,
    automationTrend: dash.charts.monthly.map((m) => ({ month: m.month, automationRate: m.automationRate })),
  };
}
