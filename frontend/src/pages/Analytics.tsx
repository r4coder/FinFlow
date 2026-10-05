import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';
import { money } from '../lib/utils';
import { Card, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui';
import { FrequencyChart, ProcessingChart, RateChart, RiskChart, SpendChart, StatusChart, VendorChart, VolumeChart } from '../components/charts';

export default function Analytics() {
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => unwrap<any>(api.get('/analytics/dashboard')) });
  const a = useQuery({ queryKey: ['analytics-automation'], queryFn: () => unwrap<any>(api.get('/analytics/automation')) });
  if (d.isLoading || a.isLoading) return <Spinner />;
  if (d.error || a.error) return <ErrorBox error={d.error ?? a.error} />;
  const { metrics, charts, kpis } = d.data;
  const au = a.data;
  return (
    <>
      <PageHeader title="Analytics" subtitle="Spend, throughput and how much work your automation is really doing." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Total invoice value" value={money(metrics.totalInvoiceValue)} />
        <Stat label="Average invoice" value={money(metrics.averageInvoiceValue)} />
        <Stat label="Automation rate" value={`${kpis.automationRate}%`} tone="text-indigo-600" />
        <Stat label="Manual review rate" value={`${kpis.manualReviewRate}%`} />
        <Stat label="Avg processing time" value={`${metrics.averageProcessingMs} ms`} />
        <Stat label="Approval rate" value={`${metrics.approvalRate}%`} tone="text-emerald-600" />
        <Stat label="Rejection rate" value={`${metrics.rejectionRate}%`} tone="text-red-600" />
        <Stat label="Exception rate" value={`${metrics.exceptionRate}%`} tone="text-orange-600" />
        <Stat label="Duplicate rate" value={`${metrics.duplicateRate}%`} tone="text-red-600" />
        <Stat label="Rule executions (matched)" value={au.totals.matched} sub={`${au.totals.evaluated} evaluations`} />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Monthly spend"><SpendChart data={charts.monthly} /></Card>
        <Card title="Monthly invoice volume"><VolumeChart data={charts.monthly} /></Card>
        <Card title="Vendor spend"><VendorChart data={charts.vendorSpend} /></Card>
        <Card title="Invoice status"><StatusChart data={charts.statusBreakdown} /></Card>
        <Card title="Risk distribution"><RiskChart data={charts.riskDistribution} /></Card>
        <Card title="Processing time (avg per month)"><ProcessingChart data={charts.monthly} /></Card>
      </div>

      <h2 className="mb-3 mt-10 text-lg font-semibold">Automation performance</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Most triggered rules">
          <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {au.mostTriggered.filter((r: any) => r.executions > 0).map((r: any, i: number) => (
              <li key={r.ruleId} className="flex items-center justify-between px-5 py-3 text-sm"><span><span className="mr-3 text-slate-400">{i + 1}.</span>{r.name}</span><span className="font-semibold tabular-nums">{r.executions} executions</span></li>
            ))}
            {au.mostTriggered.every((r: any) => r.executions === 0) && <li className="p-5 text-sm text-slate-500">No rule has matched yet.</li>}
          </ol>
        </Card>
        <Card title="Rule executions per day (last 30 days)"><FrequencyChart data={au.executionsPerDay} /></Card>
        <Card title="Automation rate by month" className="lg:col-span-2"><RateChart data={au.automationTrend} /></Card>
        <Card title="Rule statistics" className="lg:col-span-2">
          <div className="overflow-x-auto"><table><thead><tr><th>Rule</th><th>Priority</th><th>Executions</th><th>Successful</th><th>Failed</th><th>Avg execution time</th></tr></thead><tbody>
            {au.rules.map((r: any) => <tr key={r.ruleId} className={r.enabled ? '' : 'opacity-50'}><td className="font-medium">{r.name}</td><td>{r.priority}</td><td className="tabular-nums">{r.executions}</td><td className="tabular-nums text-emerald-600">{r.successful}</td><td className="tabular-nums text-red-600">{r.failed}</td><td className="tabular-nums">{r.avgDurationMs} ms</td></tr>)}
          </tbody></table></div>
        </Card>
      </div>
    </>
  );
}
