import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Eye, Pencil, RefreshCw, X } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, dateStr, dateTime, money, pretty } from '../lib/utils';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { RuleTrace } from '../components/RuleTrace';

const EDITABLE = ['MANUAL_REVIEW', 'FAILED', 'EXTRACTED', 'UPLOADED'];

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><div className="mt-0.5 text-sm font-medium">{children ?? '—'}</div></div>;
}

function EditModal({ inv, onClose }: { inv: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<any>({ invoiceNumber: inv.invoiceNumber ?? '', vendorName: inv.vendor?.name ?? '', invoiceDate: inv.invoiceDate ?? '', dueDate: inv.dueDate ?? '', currency: inv.currency ?? 'INR', subtotal: inv.subtotal ?? '', tax: inv.tax ?? '', total: inv.total ?? '', purchaseOrderNumber: inv.purchaseOrderNumber ?? '', paymentTerms: inv.paymentTerms ?? '' });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      const n = (x: any) => (x === '' ? null : Number(x));
      const s = (x: any) => (x === '' ? null : x);
      await api.patch(`/invoices/${inv.id}`, { invoiceNumber: s(v.invoiceNumber), vendorName: s(v.vendorName), invoiceDate: s(v.invoiceDate), dueDate: s(v.dueDate), currency: s(v.currency), subtotal: n(v.subtotal), tax: n(v.tax), total: n(v.total), purchaseOrderNumber: s(v.purchaseOrderNumber), paymentTerms: s(v.paymentTerms) });
      await api.post(`/invoices/${inv.id}/reprocess`, { reextract: false });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoice', inv.id] }); onClose(); },
    onError: (e) => setErr(errMsg(e)),
  });
  const u = (k: string) => (e: any) => setV((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title="Edit extracted data" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save & re-run validation and rules</Button></>}>
      <p className="mb-4 text-sm text-slate-500">Saving re-runs validation, duplicate detection and your rules on the corrected data. The AI is not called again.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Invoice number"><input className="w-full" value={v.invoiceNumber} onChange={u('invoiceNumber')} /></Field>
        <Field label="Vendor"><input className="w-full" value={v.vendorName} onChange={u('vendorName')} /></Field>
        <Field label="PO number"><input className="w-full" value={v.purchaseOrderNumber} onChange={u('purchaseOrderNumber')} /></Field>
        <Field label="Invoice date"><input className="w-full" type="date" value={v.invoiceDate} onChange={u('invoiceDate')} /></Field>
        <Field label="Due date"><input className="w-full" type="date" value={v.dueDate} onChange={u('dueDate')} /></Field>
        <Field label="Currency"><input className="w-full" maxLength={3} value={v.currency} onChange={u('currency')} /></Field>
        <Field label="Subtotal"><input className="w-full" type="number" step="0.01" value={v.subtotal} onChange={u('subtotal')} /></Field>
        <Field label="Tax"><input className="w-full" type="number" step="0.01" value={v.tax} onChange={u('tax')} /></Field>
        <Field label="Total"><input className="w-full" type="number" step="0.01" value={v.total} onChange={u('total')} /></Field>
      </div>
      {err && <p role="alert" className="mt-3 text-sm text-red-600">{err}</p>}
    </Modal>
  );
}

function DecisionModal({ approval, action, onClose }: { approval: any; action: 'approve' | 'reject' | 'request-changes'; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/approvals/${approval.id}/${action}`, { comment }),
    onSuccess: () => { qc.invalidateQueries(); onClose(); },
    onError: (e) => setErr(errMsg(e)),
  });
  const need = action !== 'approve';
  return (
    <Modal open onClose={onClose} title={action === 'approve' ? 'Approve invoice' : action === 'reject' ? 'Reject invoice' : 'Request changes'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={action === 'approve' ? 'success' : action === 'reject' ? 'danger' : 'primary'} loading={m.isPending} disabled={need && comment.trim().length < 3} onClick={() => m.mutate()}>{pretty(action.replace('-', '_'))}</Button></>}>
      <Field label={need ? 'Reason (required)' : 'Comment (optional)'}><textarea className="w-full" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  );
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [decision, setDecision] = useState<{ approval: any; action: 'approve' | 'reject' | 'request-changes' } | null>(null);
  const [docUrl, setDocUrl] = useState<{ url: string; mime: string } | null>(null);
  const [openExec, setOpenExec] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => unwrap<any>(api.get(`/invoices/${id}`)),
    refetchInterval: (query) => (['UPLOADED', 'PROCESSING', 'EXTRACTED', 'VALIDATING'].includes((query.state.data as any)?.status) ? 2000 : false),
  });
  const reprocess = useMutation({ mutationFn: (reextract: boolean) => api.post(`/invoices/${id}/reprocess`, { reextract }), onSuccess: () => qc.invalidateQueries({ queryKey: ['invoice', id] }) });
  const viewDoc = async () => {
    const r = await api.get(`/invoices/${id}/file`, { responseType: 'blob' });
    setDocUrl({ url: URL.createObjectURL(r.data), mime: r.data.type });
  };
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  const inv = q.data;
  const processing = ['UPLOADED', 'PROCESSING', 'EXTRACTED', 'VALIDATING'].includes(inv.status);
  const run = inv.executions.filter((e: any) => e.runKey.startsWith(inv.latestRunKey));
  const mainRun = run.filter((e: any) => e.depth === 0);
  const events = run.filter((e: any) => e.depth > 0);
  const findings = inv.validation?.findings ?? [];
  const pending = inv.approvals.filter((a: any) => a.status === 'PENDING' && a.canDecide !== false);

  return (
    <>
      <PageHeader
        title={inv.invoiceNumber ?? inv.fileName ?? 'Invoice'}
        subtitle={`${inv.vendor?.name ?? 'Unknown vendor'} · uploaded ${dateTime(inv.createdAt)}${inv.uploadedByName ? ` by ${inv.uploadedByName}` : ''}`}
        actions={<>
          {inv.hasFile && <Button variant="secondary" onClick={viewDoc}><Eye className="h-4 w-4" /> View document</Button>}
          {can('invoice:write') && EDITABLE.includes(inv.status) && <Button variant="secondary" onClick={() => setEdit(true)}><Pencil className="h-4 w-4" /> Edit data</Button>}
          {can('invoice:write') && ['MANUAL_REVIEW', 'FAILED', 'PENDING_APPROVAL'].includes(inv.status) && inv.hasFile && <Button variant="secondary" loading={reprocess.isPending} onClick={() => reprocess.mutate(true)}><RefreshCw className="h-4 w-4" /> Retry AI</Button>}
          {can('invoice:write') && ['MANUAL_REVIEW', 'PENDING_APPROVAL'].includes(inv.status) && <Button variant="secondary" loading={reprocess.isPending} onClick={() => reprocess.mutate(false)}>Re-run rules</Button>}
        </>}
      />
      {reprocess.error && <ErrorBox error={reprocess.error} />}
      {processing && <div className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-300"><RefreshCw className="h-4 w-4 animate-spin" /> Processing: {pretty(inv.status)}… this page updates automatically.</div>}
      {inv.status === 'FAILED' && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"><p className="font-semibold">Processing failed</p><p>{inv.failureReason}</p>{can('invoice:write') && inv.hasFile && <Button className="mt-2" size="sm" onClick={() => reprocess.mutate(true)}>Retry</Button>}</div>}
      {inv.status === 'MANUAL_REVIEW' && inv.exceptionReasons?.length > 0 && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-300"><p className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> In the exception queue</p><ul className="list-inside list-disc">{inv.exceptionReasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul><Link to="/exceptions" className="mt-2 inline-block text-indigo-600 underline">Go to exception queue</Link></div>
      )}

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4 lg:grid-cols-8">
          <Fact label="Amount"><span className="text-lg">{money(inv.total, inv.currency)}</span></Fact>
          <Fact label="Status"><StatusBadge value={inv.status} /></Fact>
          <Fact label="Risk"><StatusBadge value={inv.riskLevel} /></Fact>
          <Fact label="AI confidence">{inv.aiConfidence === null ? '—' : `${Math.round(inv.aiConfidence * 100)}%`}</Fact>
          <Fact label="Invoice date">{dateStr(inv.invoiceDate)}</Fact>
          <Fact label="Due date">{dateStr(inv.dueDate)}</Fact>
          <Fact label="PO number">{inv.purchaseOrderNumber ?? <Badge color="amber">Missing</Badge>}</Fact>
          <Fact label="Processing time">{inv.processingMs ? `${inv.processingMs} ms` : '—'}</Fact>
        </div>
        {inv.tags?.length > 0 && <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800"><span className="text-xs text-slate-500">Tags</span>{inv.tags.map((t: string) => <Badge key={t} color="indigo">{t}</Badge>)}</div>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="AI extraction">
          <div className="space-y-4 p-5">
            <div className="grid grid-cols-3 gap-4"><Fact label="Subtotal">{money(inv.subtotal, inv.currency)}</Fact><Fact label="Tax">{money(inv.tax, inv.currency)}</Fact><Fact label="Total">{money(inv.total, inv.currency)}</Fact></div>
            <div className="grid grid-cols-2 gap-4"><Fact label="Vendor">{inv.vendor ? <>{inv.vendor.name} {!inv.vendor.verified && <Badge color="amber">Unverified</Badge>}</> : '—'}</Fact><Fact label="Payment terms">{inv.paymentTerms}</Fact></div>
            {inv.lineItems.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-slate-100 dark:border-slate-800"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>{inv.lineItems.map((l: any) => <tr key={l.id}><td>{l.description}</td><td>{l.quantity}</td><td>{money(l.unitPrice, inv.currency)}</td><td>{money(l.lineTotal, inv.currency)}</td></tr>)}</tbody></table></div>
            ) : <p className="text-sm text-slate-500">No line items.</p>}
            {inv.aiAnalysis && <div className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800"><p className="mb-1 text-xs font-semibold uppercase text-slate-500">AI risk explanation ({inv.aiAnalysis.source}) · score {inv.aiAnalysis.aiScore}/100</p>{inv.aiAnalysis.explanation}<p className="mt-2 text-xs text-slate-500">The AI explains the risk; it cannot change it or override your rules.</p></div>}
            {inv.aiJobs?.[0] && <p className="text-xs text-slate-500">Extraction by <b>{inv.aiJobs[0].provider}</b>{inv.aiJobs[0].model ? ` (${inv.aiJobs[0].model})` : ''} · {inv.aiJobs.length} attempt(s)</p>}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Validation">
            <div className="p-5">
              {findings.length === 0 && !inv.validation ? <p className="text-sm text-slate-500">Not validated yet.</p> : findings.length === 0 ? <p className="flex items-center gap-2 text-sm text-emerald-600"><Check className="h-4 w-4" /> All arithmetic and field checks passed.</p> : (
                <ul className="space-y-2">{findings.map((f: any, i: number) => <li key={i} className="flex items-start gap-2 text-sm"><Badge color={f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'amber' : 'slate'}>{pretty(f.code)}</Badge><span>{f.message}</span></li>)}</ul>
              )}
              {inv.validation?.derivedFields?.length > 0 && <p className="mt-3 text-xs text-slate-500">Computed by code (not AI): {inv.validation.derivedFields.join(', ')}</p>}
              {inv.anomalies?.length > 0 && <><p className="mb-1 mt-4 text-xs font-semibold uppercase text-slate-500">Anomalies</p><ul className="space-y-1.5">{inv.anomalies.map((a: any, i: number) => <li key={i} className="flex items-start gap-2 text-sm"><Badge color={a.severity === 'high' ? 'red' : a.severity === 'medium' ? 'amber' : 'slate'}>{pretty(a.code)}</Badge><span>{a.message}</span></li>)}</ul></>}
            </div>
          </Card>
          <Card title="Duplicate detection">
            <div className="p-5 text-sm">{inv.duplicateDetected ? <p className="text-red-600">Possible duplicate of <Link className="underline" to={`/invoices/${inv.duplicateOf?.id}`}>{inv.duplicateOf?.invoiceNumber ?? 'an earlier invoice'}</Link> (matched on vendor + number + date + total, or identical file fingerprint).</p> : <p className="flex items-center gap-2 text-emerald-600"><Check className="h-4 w-4" /> No duplicate found.</p>}</div>
          </Card>
        </div>

        <Card title="Business rules" className="lg:col-span-2">
          {mainRun.length === 0 ? <Empty title="No rules evaluated yet" hint="Rules run after extraction and validation." /> : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {[...mainRun].sort((a, b) => Number(b.matched) - Number(a.matched)).map((e: any) => (
                <li key={e.id} className="px-5 py-3">
                  <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpenExec(openExec === e.id ? null : e.id)}>
                    <span className="flex items-center gap-2 text-sm"><span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-white', e.matched ? 'bg-emerald-500' : 'bg-slate-300')}>{e.matched ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}</span><span className="font-medium">{e.ruleName}</span> <span className="text-xs text-slate-400">v{e.ruleVersion}</span></span>
                    <span className="flex items-center gap-2">{e.matched ? <Badge color="green">MATCHED</Badge> : <span className="text-xs text-slate-500">Not matched</span>}{e.matched && <StatusBadge value={e.result} />}</span>
                  </button>
                  {openExec === e.id && (
                    <div className="mt-3 space-y-3">
                      <RuleTrace node={e.conditionsEvaluated} />
                      {e.actionsExecuted?.length > 0 && <ul className="space-y-1">{e.actionsExecuted.map((a: any, i: number) => <li key={i} className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge value={a.status} /><span className="font-medium">{a.description}</span><span className="text-slate-500">— {a.detail}</span></li>)}</ul>}
                      {e.error && <p className="text-xs text-red-600">{e.error}</p>}
                      <p className="text-xs text-slate-400">{dateTime(e.startedAt)} · {e.durationMs} ms</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {events.length > 0 && <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500 dark:border-slate-800">Follow-up events: {events.filter((e: any) => e.matched).map((e: any) => `${e.ruleName} (${pretty(e.trigger)})`).join(', ') || 'none matched'}</div>}
        </Card>

        <Card title="Approval" className="lg:col-span-2">
          {inv.approvals.length === 0 ? <p className="p-5 text-sm text-slate-500">{inv.autoApproved ? 'This invoice was approved automatically by your rules — no human approval was required.' : 'No approval requested.'}</p> : (
            <div className="overflow-x-auto"><table><thead><tr><th>Level</th><th>Approver</th><th>Status</th><th>Decided</th><th>Comment</th><th /></tr></thead><tbody>
              {inv.approvals.map((a: any) => (
                <tr key={a.id}><td>{a.level} of {a.totalLevels}</td><td>{a.approverUserId ? 'Specific user' : pretty(a.approverRole)}</td><td><StatusBadge value={a.status} /></td><td>{a.decidedByName ? `${a.decidedByName} · ${dateTime(a.decidedAt)}` : '—'}</td><td className="max-w-xs truncate">{a.comment ?? '—'}</td>
                  <td className="space-x-1 text-right">{a.status === 'PENDING' && can('invoice:approve') && <><Button size="sm" variant="success" onClick={() => setDecision({ approval: a, action: 'approve' })}>Approve</Button><Button size="sm" variant="danger" onClick={() => setDecision({ approval: a, action: 'reject' })}>Reject</Button><Button size="sm" variant="secondary" onClick={() => setDecision({ approval: a, action: 'request-changes' })}>Request changes</Button></>}</td></tr>
              ))}
            </tbody></table></div>
          )}
          {inv.status === 'REJECTED' && <p className="border-t border-slate-100 p-4 text-sm text-red-600 dark:border-slate-800">Rejected{inv.rejectedByName ? ` by ${inv.rejectedByName}` : ''}: {inv.rejectionReason}</p>}
          {pending.length === 0 && null}
        </Card>

        {inv.tasks?.length > 0 && (
          <Card title="Tasks created by automation" className="lg:col-span-2"><ul className="divide-y divide-slate-100 dark:divide-slate-800">{inv.tasks.map((t: any) => <li key={t.id} className="flex items-center justify-between px-5 py-3 text-sm"><span>{t.title}</span><span className="flex items-center gap-2"><Badge color={t.priority === 'HIGH' ? 'red' : 'slate'}>{t.priority}</Badge><span className="text-xs text-slate-500">due {dateStr(t.dueAt)}</span><StatusBadge value={t.status} /></span></li>)}</ul></Card>
        )}

        <Card title="Audit timeline" className="lg:col-span-2">
          <ol className="relative space-y-4 p-5 pl-8 before:absolute before:left-[1.65rem] before:top-5 before:h-[calc(100%-2.5rem)] before:w-px before:bg-slate-200 dark:before:bg-slate-700">
            {inv.timeline.map((t: any) => (
              <li key={t.id} className="relative">
                <span className="absolute -left-[1.45rem] top-1.5 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-4 ring-white dark:ring-slate-900" />
                <p className="text-sm font-medium">{pretty(t.action.replace('.', ' '))}{t.userName && <span className="font-normal text-slate-500"> · {t.userName}</span>}</p>
                <p className="text-xs text-slate-400">{dateTime(t.createdAt)}</p>
                {t.metadata && Object.keys(t.metadata).length > 0 && <p className="mt-0.5 break-words text-xs text-slate-500">{Object.entries(t.metadata).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {edit && <EditModal inv={inv} onClose={() => setEdit(false)} />}
      {decision && <DecisionModal approval={decision.approval} action={decision.action} onClose={() => setDecision(null)} />}
      <Modal open={!!docUrl} onClose={() => { if (docUrl) URL.revokeObjectURL(docUrl.url); setDocUrl(null); }} title={inv.fileName ?? 'Document'} wide>
        {docUrl && (docUrl.mime.startsWith('image/') ? <img src={docUrl.url} alt="Invoice document" className="mx-auto max-h-[70vh]" /> : <iframe src={docUrl.url} title="Invoice document" className="h-[70vh] w-full rounded-lg border" />)}
      </Modal>
    </>
  );
}
