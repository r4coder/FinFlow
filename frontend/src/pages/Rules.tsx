import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, cn } from '../lib/utils';
import { Badge, Button, Card, Confirm, Empty, ErrorBox, PageHeader, Pagination, Spinner } from '../components/ui';

export function RulesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [del, setDel] = useState<any>(null);
  const [err, setErr] = useState('');
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page, pageSize: 25 };
  const meta = useQuery({ queryKey: ['rule-meta'], queryFn: () => unwrap<any>(api.get('/automation/metadata')) });
  const q = useQuery({ queryKey: ['rules', params], queryFn: () => unwrap<any>(api.get('/automation/rules', { params })) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['rules'] });
  const toggle = useMutation({ mutationFn: (r: any) => api.patch(`/automation/rules/${r.id}`, { enabled: !r.enabled }), onSuccess: refresh, onError: (e) => setErr(errMsg(e)) });
  const dup = useMutation({ mutationFn: (id: string) => unwrap<any>(api.post(`/automation/rules/${id}/duplicate`)), onSuccess: (r) => nav(`/automation/rules/${r.id}`), onError: (e) => setErr(errMsg(e)) });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/automation/rules/${id}`), onSuccess: () => { setDel(null); refresh(); }, onError: (e) => setErr(errMsg(e)) });
  const set = (k: string, v: string) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };
  const write = can('rule:write');
  return (
    <>
      <PageHeader title="Automation rules" subtitle="Your company's invoice policies. Rules decide what happens to every invoice — AI only extracts and explains." actions={<>
        <Link to="/automation/templates"><Button variant="secondary"><Wand2 className="h-4 w-4" /> Templates</Button></Link>
        {write && <Button onClick={() => nav('/automation/rules/new')}><Plus className="h-4 w-4" /> New rule</Button>}
      </>} />
      {err && <ErrorBox error={{ message: err }} />}
      <Card>
        <div className="grid gap-3 border-b border-slate-100 p-4 dark:border-slate-800 sm:grid-cols-4">
          <input placeholder="Search rules…" value={f.search ?? ''} onChange={(e) => set('search', e.target.value)} aria-label="Search rules" />
          <select value={f.trigger ?? ''} onChange={(e) => set('trigger', e.target.value)} aria-label="Trigger"><option value="">All triggers</option>{meta.data?.triggers.map((t: any) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
          <select value={f.enabled ?? ''} onChange={(e) => set('enabled', e.target.value)} aria-label="Status"><option value="">Enabled & disabled</option><option value="true">Enabled</option><option value="false">Disabled</option></select>
          <select value={f.sortBy ?? 'priority'} onChange={(e) => set('sortBy', e.target.value)} aria-label="Sort"><option value="priority">Sort: priority</option><option value="name">Sort: name</option><option value="updatedAt">Sort: recently changed</option></select>
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="No rules yet" hint="Start from a template or build your own." action={write ? <Button onClick={() => nav('/automation/templates')}>Browse templates</Button> : undefined} /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>Priority</th><th>Rule</th><th>Trigger</th><th>If…</th><th>Then…</th><th>Status</th><th>Last run</th><th>Runs</th><th /></tr></thead><tbody>
            {q.data.items.map((r: any) => (
              <tr key={r.id} className={cn('align-top hover:bg-slate-50 dark:hover:bg-slate-800/50', !r.enabled && 'opacity-60')}>
                <td><Badge color="indigo">{r.priority}</Badge></td>
                <td className="min-w-48"><Link to={`/automation/rules/${r.id}`} className="font-medium text-indigo-600 hover:underline">{r.name}</Link><p className="text-xs text-slate-500">{r.description}</p><p className="text-[11px] text-slate-400">v{r.version}{r.createdByName ? ` · by ${r.createdByName}` : ''}</p></td>
                <td className="whitespace-nowrap text-xs">{r.triggerLabel}</td>
                <td className="max-w-xs text-xs text-slate-600 dark:text-slate-300">{r.conditionsSummary}</td>
                <td className="max-w-xs text-xs"><ul className="space-y-0.5">{r.actionsSummary.map((a: string, i: number) => <li key={i}>• {a}</li>)}</ul></td>
                <td><label className="inline-flex cursor-pointer items-center gap-2"><input type="checkbox" role="switch" aria-label={`Enable ${r.name}`} checked={r.enabled} disabled={!write || toggle.isPending} onChange={() => toggle.mutate(r)} /><span className="text-xs font-medium">{r.enabled ? 'ON' : 'OFF'}</span></label></td>
                <td className="whitespace-nowrap text-xs text-slate-500">{r.lastExecutionAt ? dateTime(r.lastExecutionAt) : 'Never'}</td>
                <td className="tabular-nums">{r.executionCount}</td>
                <td className="whitespace-nowrap text-right">
                  <Link to={`/automation/rules/${r.id}`}><Button size="sm" variant="ghost" aria-label={`Edit ${r.name}`}><Pencil className="h-4 w-4" /></Button></Link>
                  {write && <><Button size="sm" variant="ghost" aria-label={`Duplicate ${r.name}`} onClick={() => dup.mutate(r.id)}><Copy className="h-4 w-4" /></Button><Button size="sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDel(r)}><Trash2 className="h-4 w-4 text-red-500" /></Button></>}
                </td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
      <Confirm open={!!del} danger title="Delete rule?" confirmLabel="Delete rule" loading={remove.isPending} message={<>“{del?.name}” will stop running immediately. Its history and past executions are kept for audit purposes.</>} onConfirm={() => remove.mutate(del.id)} onClose={() => setDel(null)} />
    </>
  );
}

export function TemplatesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['rule-templates'], queryFn: () => unwrap<any[]>(api.get('/automation/templates')) });
  return (
    <>
      <PageHeader title="Rule templates" subtitle="Proven starting points. Using a template opens it in the builder so you can adjust it before saving — your organization's rules are always independent." />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data!.map((t) => (
            <Card key={t.key} className="flex flex-col">
              <div className="flex-1 space-y-3 p-5">
                <div><h3 className="font-semibold">{t.name}</h3><p className="text-sm text-slate-500">{t.description}</p></div>
                <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800"><p className="font-bold text-indigo-600">IF</p><p>{t.conditionsSummary}</p><p className="mt-2 font-bold text-emerald-600">THEN</p><ul>{t.actionsSummary.map((a: string, i: number) => <li key={i}>• {a}</li>)}</ul></div>
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 dark:border-slate-800"><Badge>Priority {t.priority}</Badge>{can('rule:write') && <Button size="sm" onClick={() => nav(`/automation/rules/new?template=${t.key}`)}>Use template</Button>}</div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
