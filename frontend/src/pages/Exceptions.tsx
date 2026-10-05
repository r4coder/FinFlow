import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money } from '../lib/utils';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Pagination, Spinner, StatusBadge } from '../components/ui';

export default function Exceptions() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [dlg, setDlg] = useState<{ id: string; action: 'APPROVE' | 'REJECT' | 'SEND_FOR_APPROVAL' } | null>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const q = useQuery({ queryKey: ['exceptions', page], queryFn: () => unwrap<any>(api.get('/exceptions', { params: { page, pageSize: 15 } })) });
  const resolve = useMutation({ mutationFn: () => api.post(`/exceptions/${dlg!.id}/resolve`, { action: dlg!.action, note }), onSuccess: () => { qc.invalidateQueries(); setDlg(null); setNote(''); setErr(''); }, onError: (e) => setErr(errMsg(e)) });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/invoices/${id}/reprocess`, { reextract: true }), onSuccess: () => qc.invalidateQueries() });
  const titles = { APPROVE: 'Approve invoice', REJECT: 'Reject invoice', SEND_FOR_APPROVAL: 'Send for approval' };
  return (
    <>
      <PageHeader title="Exception queue" subtitle="Invoices your automation could not safely decide: duplicates, missing PO, low confidence, failed processing, rule overrides." />
      {retry.error && <ErrorBox error={retry.error} />}
      <Card>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="No exceptions" hint="Everything has been handled automatically or routed for approval." /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>Invoice</th><th>Vendor</th><th>Amount</th><th>Status</th><th>Risk</th><th>Why it's here</th><th>Updated</th><th /></tr></thead><tbody>
            {q.data.items.map((x: any) => (
              <tr key={x.id} className="align-top">
                <td><Link className="font-medium text-indigo-600 hover:underline" to={`/invoices/${x.id}`}>{x.invoiceNumber ?? x.fileName}</Link></td>
                <td>{x.vendor ?? '—'}</td><td className="tabular-nums">{money(x.total, x.currency)}</td><td><StatusBadge value={x.status} /></td><td><StatusBadge value={x.riskLevel} /></td>
                <td className="max-w-sm"><ul className="space-y-0.5 text-xs">{x.duplicateDetected && <li><Badge color="red">Duplicate</Badge></li>}{(x.failureReason ? [x.failureReason] : x.reasons).map((r: string, i: number) => <li key={i} className="text-slate-600 dark:text-slate-300">• {r}</li>)}</ul></td>
                <td className="whitespace-nowrap text-xs text-slate-500">{dateTime(x.updatedAt)}</td>
                <td className="space-x-1 whitespace-nowrap text-right">
                  <Link to={`/invoices/${x.id}`}><Button size="sm" variant="secondary">Review</Button></Link>
                  {can('invoice:write') && <Button size="sm" variant="secondary" loading={retry.isPending && retry.variables === x.id} onClick={() => retry.mutate(x.id)}>Retry AI</Button>}
                  {x.status === 'MANUAL_REVIEW' && can('invoice:write') && <Button size="sm" variant="secondary" onClick={() => setDlg({ id: x.id, action: 'SEND_FOR_APPROVAL' })}>Send for approval</Button>}
                  {x.status === 'MANUAL_REVIEW' && can('invoice:approve') && <><Button size="sm" variant="success" onClick={() => setDlg({ id: x.id, action: 'APPROVE' })}>Approve</Button><Button size="sm" variant="danger" onClick={() => setDlg({ id: x.id, action: 'REJECT' })}>Reject</Button></>}
                </td>
              </tr>
            ))}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
      <Modal open={!!dlg} onClose={() => setDlg(null)} title={dlg ? titles[dlg.action] : ''} footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button loading={resolve.isPending} disabled={dlg?.action === 'REJECT' && note.trim().length < 3} variant={dlg?.action === 'REJECT' ? 'danger' : 'primary'} onClick={() => resolve.mutate()}>Confirm</Button></>}>
        <Field label={dlg?.action === 'REJECT' ? 'Reason (required)' : 'Note (optional)'}><textarea className="w-full" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
      </Modal>
    </>
  );
}
