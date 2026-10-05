import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, Upload } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateStr, money } from '../lib/utils';
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Pagination, Spinner, StatusBadge } from '../components/ui';

const STATUSES = ['UPLOADED', 'PROCESSING', 'PENDING_APPROVAL', 'MANUAL_REVIEW', 'APPROVED', 'REJECTED', 'PAID', 'FAILED'];

export default function Invoices() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState<Record<string, string>>({ sortBy: 'createdAt', sortDir: 'desc' });
  const [page, setPage] = useState(1);
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')), page, pageSize: 15 };
  const q = useQuery({
    queryKey: ['invoices', params],
    queryFn: () => unwrap<any>(api.get('/invoices', { params })),
    refetchInterval: (query) => ((query.state.data as any)?.items?.some((i: any) => ['UPLOADED', 'PROCESSING', 'EXTRACTED', 'VALIDATING'].includes(i.status)) ? 2500 : false),
  });
  const set = (k: string, v: string) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  const sort = (k: string) => setF((p) => ({ ...p, sortBy: k, sortDir: p.sortBy === k && p.sortDir === 'desc' ? 'asc' : 'desc' }));
  const exportCsv = async () => {
    try {
      const r = await api.get('/invoices/export.csv', { params: { ...params, page: undefined, pageSize: undefined }, responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = 'invoices.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert(errMsg(e)); }
  };
  const Th = ({ k, children }: { k: string; children: string }) => (
    <th><button className="inline-flex items-center gap-1 uppercase" onClick={() => sort(k)}>{children}{f.sortBy === k && (f.sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}</button></th>
  );
  return (
    <>
      <PageHeader title="Invoices" subtitle="Every invoice, from upload to approval." actions={<><Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>{can('invoice:write') && <Button onClick={() => nav('/invoices/upload')}><Upload className="h-4 w-4" /> Upload</Button>}</>} />
      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-4 dark:border-slate-800 sm:grid-cols-2 lg:grid-cols-6">
          <input className="lg:col-span-2" placeholder="Search invoice #, vendor, file…" value={f.search ?? ''} onChange={(e) => set('search', e.target.value)} aria-label="Search" />
          <select value={f.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Status"><option value="">All statuses</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <select value={f.risk ?? ''} onChange={(e) => set('risk', e.target.value)} aria-label="Risk"><option value="">All risk levels</option>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}</select>
          <input placeholder="Currency (INR)" maxLength={3} value={f.currency ?? ''} onChange={(e) => set('currency', e.target.value.toUpperCase())} aria-label="Currency" />
          <div className="flex gap-2"><input className="w-full" type="number" placeholder="Min ₹" value={f.minAmount ?? ''} onChange={(e) => set('minAmount', e.target.value)} aria-label="Minimum amount" /><input className="w-full" type="number" placeholder="Max ₹" value={f.maxAmount ?? ''} onChange={(e) => set('maxAmount', e.target.value)} aria-label="Maximum amount" /></div>
          <label className="flex items-center gap-2 text-xs text-slate-500">From <input type="date" value={f.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value)} /></label>
          <label className="flex items-center gap-2 text-xs text-slate-500">To <input type="date" value={f.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value)} /></label>
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? (
          <Empty title="No invoices found" hint="Upload an invoice or adjust the filters." action={can('invoice:write') ? <Button onClick={() => nav('/invoices/upload')}>Upload invoice</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead><tr><Th k="invoiceNumber">Invoice #</Th><th>Vendor</th><Th k="invoiceDate">Date</Th><Th k="total">Amount</Th><Th k="riskLevel">Risk</Th><Th k="status">Status</Th><th>Tags</th></tr></thead>
              <tbody>
                {q.data.items.map((i: any) => (
                  <tr key={i.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td><Link className="font-medium text-indigo-600 hover:underline" to={`/invoices/${i.id}`}>{i.invoiceNumber ?? i.fileName ?? i.id.slice(0, 8)}</Link>{i.duplicateDetected && <span className="ml-2"><Badge color="red">Duplicate</Badge></span>}</td>
                    <td>{i.vendor?.name ?? '—'}</td>
                    <td>{dateStr(i.invoiceDate)}</td>
                    <td className="font-medium tabular-nums">{money(i.total, i.currency)}</td>
                    <td><StatusBadge value={i.riskLevel} /></td>
                    <td><StatusBadge value={i.status} />{i.autoApproved && <span className="ml-1 text-[10px] text-slate-400">auto</span>}</td>
                    <td className="space-x-1">{i.tags?.map((t: string) => <Badge key={t} color="indigo">{t}</Badge>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
    </>
  );
}
