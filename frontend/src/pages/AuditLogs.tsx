import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';
import { dateTime, pretty } from '../lib/utils';
import { Card, Empty, ErrorBox, PageHeader, Pagination, Spinner } from '../components/ui';

const PREFIXES = ['invoice.', 'rule.', 'approval.', 'exception.', 'user.', 'ai.', 'vendor.', 'organization.'];

export default function AuditLogs() {
  const [f, setF] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page, pageSize: 40 };
  const q = useQuery({ queryKey: ['audit', params], queryFn: () => unwrap<any>(api.get('/audit-logs', { params })) });
  const set = (k: string, v: string) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  return (
    <>
      <PageHeader title="Audit logs" subtitle="An append-only record of what happened, who did it and when. Secrets are never logged." />
      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-4 dark:border-slate-800 sm:grid-cols-3">
          <select value={f.action ?? ''} onChange={(e) => set('action', e.target.value)} aria-label="Event type"><option value="">All events</option>{PREFIXES.map((p) => <option key={p} value={p}>{pretty(p.replace('.', ''))} events</option>)}</select>
          <input type="date" value={f.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value)} aria-label="From date" />
          <input type="date" value={f.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value)} aria-label="To date" />
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="No audit events" /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Details</th></tr></thead><tbody>
            {q.data.items.map((l: any) => (
              <tr key={l.id} className="align-top"><td className="whitespace-nowrap text-xs">{dateTime(l.createdAt)}</td><td className="font-medium">{l.invoiceId ? <Link className="text-indigo-600 hover:underline" to={`/invoices/${l.invoiceId}`}>{l.action}</Link> : l.action}</td><td>{l.userName ?? <span className="text-slate-400">system</span>}</td><td className="max-w-lg break-words text-xs text-slate-500">{l.metadata ? Object.entries(l.metadata).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : ''}</td></tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
    </>
  );
}
