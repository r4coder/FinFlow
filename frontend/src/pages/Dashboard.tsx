import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { api, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/utils';
import { Card, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui';
import { ProcessingChart, RateChart, RiskChart, SpendChart, StatusChart, VendorChart, VolumeChart } from '../components/charts';

export default function Dashboard() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => unwrap<any>(api.get('/analytics/dashboard')), refetchInterval: 20000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const { kpis, charts, onboarding } = q.data;
  const steps = [
    { done: onboarding?.aiConfigured, label: 'Configure AI (Gemini or demo mode)', to: '/settings' },
    { done: onboarding?.rulesReviewed, label: 'Review your automation rules', to: '/automation/rules' },
    { done: onboarding?.firstInvoice, label: 'Upload your first invoice', to: '/invoices/upload' },
  ];
  const showOnboarding = steps.some((s) => !s.done);
  return (
    <>
      <PageHeader title={`Welcome back, ${me?.fullName.split(' ')[0]}`} subtitle="Live overview of invoice processing and automation." />
      {showOnboarding && (
        <Card className="mb-6" title="Get started">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {steps.map((s) => (
              <li key={s.label} className="flex items-center gap-3 px-5 py-3 text-sm">
                {s.done ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <Circle className="h-5 w-5 text-slate-300" />}
                <Link to={s.to} className={s.done ? 'text-slate-400 line-through' : 'font-medium text-indigo-600 hover:underline'}>{s.label}</Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Invoices processed" value={kpis.invoicesProcessed} sub={`${kpis.totalInvoices} total`} />
        <Stat label="Pending approval" value={kpis.pendingApproval} tone="text-amber-600" />
        <Stat label="Approved" value={kpis.approved} tone="text-emerald-600" />
        <Stat label="Rejected" value={kpis.rejected} tone="text-red-600" />
        <Stat label="Exceptions" value={kpis.exceptions} tone="text-orange-600" />
        <Stat label="Automation rate" value={`${kpis.automationRate}%`} sub={`Manual review rate ${kpis.manualReviewRate}%`} tone="text-indigo-600" />
        <Stat label="Total spend (approved)" value={money(kpis.totalSpend)} />
        <Stat label="Potential duplicates" value={kpis.potentialDuplicates} tone="text-red-600" />
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Invoice volume"><VolumeChart data={charts.monthly} /></Card>
        <Card title="Spend by month"><SpendChart data={charts.monthly} /></Card>
        <Card title="Approval status"><StatusChart data={charts.statusBreakdown} /></Card>
        <Card title="Risk distribution"><RiskChart data={charts.riskDistribution} /></Card>
        <Card title="Top vendors by spend"><VendorChart data={charts.vendorSpend} /></Card>
        <Card title="Automation rate by month"><RateChart data={charts.monthly} /></Card>
        <Card title="Average processing time" className="lg:col-span-2"><ProcessingChart data={charts.monthly} /></Card>
      </div>
    </>
  );
}
