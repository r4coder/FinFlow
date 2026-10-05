import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, pretty } from '../lib/utils';
import { Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Pagination, Spinner, StatusBadge } from '../components/ui';

export function DecisionDialog({ target, onClose }: { target: { id: string; action: 'approve' | 'reject' | 'request-changes' } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/approvals/${target!.id}/${target!.action}`, { comment }), onSuccess: () => { qc.invalidateQueries(); setComment(''); onClose(); }, onError: (e) => setErr(errMsg(e)) });
  if (!target) return null;
  const need = target.action !== 'approve';
  return (
    <Modal open onClose={onClose} title={pretty(target.action.replace('-', '_'))} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={target.action === 'approve' ? 'success' : target.action === 'reject' ? 'danger' : 'primary'} loading={m.isPending} disabled={need && comment.trim().length < 3} onClick={() => m.mutate()}>Confirm</Button></>}>
      <Field label={need ? 'Reason (required)' : 'Comment (optional)'}><textarea className="w-full" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  );
}

export default function Approvals() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'mine' | 'PENDING' | 'ALL'>('mine');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState<{ id: string; action: 'approve' | 'reject' | 'request-changes' } | null>(null);
  const params: Record<string, unknown> = { page, pageSize: 15, ...(tab === 'mine' ? { mine: 'true' } : tab === 'PENDING' ? { status: 'PENDING' } : {}) };
  const q = useQuery({ queryKey: ['approvals', params], queryFn: () => unwrap<any>(api.get('/approvals', { params })), refetchInterval: 15000 });
  return (
    <>
      <PageHeader title="Approvals" subtitle="Invoices waiting for a human decision." />
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 p-1 text-sm dark:border-slate-700">
        {([['mine', 'Waiting for me'], ['PENDING', 'All pending'], ['ALL', 'History']] as const).map(([k, l]) => <button key={k} onClick={() => { setTab(k); setPage(1); }} className={`rounded-md px-4 py-1.5 font-medium ${tab === k ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}>{l}</button>)}
      </div>
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="Nothing here" hint={tab === 'mine' ? 'No approvals are waiting for you.' : 'No approvals match this view.'} /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>Invoice</th><th>Vendor</th><th>Amount</th><th>Risk</th><th>Requested by</th><th>Approver</th><th>Status</th><th>Date</th><th /></tr></thead><tbody>
            {q.data.items.map((a: any) => (
              <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td><Link className="font-medium text-indigo-600 hover:underline" to={`/invoices/${a.invoiceId}`}>{a.invoiceNumber ?? 'View'}</Link>{a.totalLevels > 1 && <span className="ml-1 text-xs text-slate-400">L{a.level}/{a.totalLevels}</span>}</td>
                <td>{a.vendor ?? '—'}</td><td className="tabular-nums">{money(a.amount, a.currency)}</td><td><StatusBadge value={a.riskLevel} /></td><td>{a.requestedBy}</td><td>{pretty(a.approver)}</td><td><StatusBadge value={a.status} /></td><td>{dateTime(a.createdAt)}</td>
                <td className="space-x-1 whitespace-nowrap text-right">{a.canDecide && can('invoice:approve') && <><Button size="sm" variant="success" onClick={() => setTarget({ id: a.id, action: 'approve' })}>Approve</Button><Button size="sm" variant="danger" onClick={() => setTarget({ id: a.id, action: 'reject' })}>Reject</Button><Button size="sm" variant="secondary" onClick={() => setTarget({ id: a.id, action: 'request-changes' })}>Changes</Button></>}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
