import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../lib/api';
import { dateTime, pretty } from '../lib/utils';
import { Badge, Card, Drawer, Empty, ErrorBox, PageHeader, Pagination, Spinner, StatusBadge } from '../components/ui';
import { RuleTrace } from '../components/RuleTrace';

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['execution', id], queryFn: () => unwrap<any>(api.get(`/automation/executions/${id}`)) });
  return (
    <Drawer open onClose={onClose} title="Rule execution">
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="space-y-5 text-sm">
          <div>
            <p className="text-lg font-semibold">{q.data.ruleName} <span className="text-xs font-normal text-slate-400">v{q.data.ruleVersion}</span></p>
            <p className="text-slate-500">{pretty(q.data.trigger)} · {dateTime(q.data.startedAt)} · {q.data.durationMs} ms {q.data.depth > 0 && `· chained event (depth ${q.data.depth})`}</p>
            <p className="mt-1">Invoice: {q.data.invoice ? <Link className="text-indigo-600 underline" to={`/invoices/${q.data.invoice.id}`}>{q.data.invoice.invoiceNumber ?? q.data.invoice.id}</Link> : '—'} · <StatusBadge value={q.data.result} /></p>
          </div>
          <div><p className="mb-2 text-xs font-semibold uppercase text-slate-500">Conditions evaluated</p><RuleTrace node={q.data.conditionsEvaluated} /></div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Actions</p>
            {q.data.matched ? (
              <ul className="space-y-2">{q.data.actionsExecuted.map((a: any, i: number) => <li key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"><div className="flex items-center justify-between"><span className="font-medium">{a.description}</span><StatusBadge value={a.status} /></div><p className="mt-1 text-xs text-slate-500">{a.detail}</p></li>)}</ul>
            ) : <p className="text-slate-500">The rule did not match, so no actions ran.</p>}
          </div>
          {q.data.error && <p className="rounded-lg bg-red-50 p-3 text-red-700 dark:bg-red-950 dark:text-red-300">{q.data.error}</p>}
        </div>
      )}
    </Drawer>
  );
}

export default function Executions() {
  const [f, setF] = useState<Record<string, string>>({ matched: 'true' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page, pageSize: 20 };
  const rules = useQuery({ queryKey: ['rules-all'], queryFn: () => unwrap<any>(api.get('/automation/rules', { params: { pageSize: 200 } })) });
  const q = useQuery({ queryKey: ['executions', params], queryFn: () => unwrap<any>(api.get('/automation/executions', { params })) });
  const set = (k: string, v: string) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  return (
    <>
      <PageHeader title="Execution history" subtitle="Every time a rule was evaluated: what it checked, whether it matched and what it did." />
      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-4 dark:border-slate-800 sm:grid-cols-2 lg:grid-cols-5">
          <select value={f.ruleId ?? ''} onChange={(e) => set('ruleId', e.target.value)} aria-label="Rule"><option value="">All rules</option>{rules.data?.items.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <select value={f.matched ?? ''} onChange={(e) => set('matched', e.target.value)} aria-label="Matched"><option value="">Matched or not</option><option value="true">Matched only</option><option value="false">Not matched</option></select>
          <select value={f.result ?? ''} onChange={(e) => set('result', e.target.value)} aria-label="Result"><option value="">Any result</option>{['SUCCESS', 'PARTIAL_FAILURE', 'FAILED', 'NOT_MATCHED'].map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select>
          <input type="date" value={f.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value)} aria-label="From date" />
          <input type="date" value={f.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value)} aria-label="To date" />
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="No executions" hint="Executions appear here as invoices are processed." /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>Date</th><th>Rule</th><th>Invoice</th><th>Result</th><th>Actions</th><th>Duration</th></tr></thead><tbody>
            {q.data.items.map((e: any) => (
              <tr key={e.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setOpen(e.id)}>
                <td className="whitespace-nowrap text-xs">{dateTime(e.startedAt)}</td>
                <td className="font-medium">{e.ruleName} {e.depth > 0 && <Badge>chained</Badge>}</td>
                <td>{e.invoiceNumber ?? '—'}</td>
                <td><StatusBadge value={e.result} /></td>
                <td className="max-w-xs text-xs text-slate-500">{e.matched ? e.actionsExecuted.map((a: any) => `${pretty(a.type)}: ${a.status.toLowerCase()}`).join(' · ') : '—'}</td>
                <td className="tabular-nums">{e.durationMs} ms</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
