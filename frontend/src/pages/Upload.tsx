import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, FileUp, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { Button, Card, Field, PageHeader } from '../components/ui';
import { cn } from '../lib/utils';

interface Item { file: File; status: 'queued' | 'uploading' | 'done' | 'error'; id?: string; error?: string }

function UploadTab() {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (files: FileList | File[]) => setItems((p) => [...p, ...Array.from(files).map((file) => ({ file, status: 'queued' as const }))]);
  const run = async () => {
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'queued') continue;
      setItems((p) => p.map((x, k) => (k === i ? { ...x, status: 'uploading' } : x)));
      try {
        const fd = new FormData();
        fd.append('file', items[i].file);
        const r = await unwrap<any>(api.post('/invoices/upload', fd));
        setItems((p) => p.map((x, k) => (k === i ? { ...x, status: 'done', id: r.id } : x)));
      } catch (e) {
        setItems((p) => p.map((x, k) => (k === i ? { ...x, status: 'error', error: errMsg(e) } : x)));
      }
    }
  };
  return (
    <Card>
      <div className="p-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
          onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
          className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition', drag ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30' : 'border-slate-300 hover:border-indigo-400 dark:border-slate-700')}
        >
          <FileUp className="h-8 w-8 text-indigo-500" />
          <p className="font-medium">Drop invoices here or click to browse</p>
          <p className="text-xs text-slate-500">PDF, PNG, JPG or JPEG · up to the configured size limit (default 10 MB)</p>
          <input ref={input} type="file" multiple hidden accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => e.target.files && add(e.target.files)} />
        </div>
        {items.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {items.map((it, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {it.status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />}
                {it.status === 'done' && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {it.status === 'error' && <XCircle className="h-4 w-4 text-red-500" />}
                {it.status === 'queued' && <FileUp className="h-4 w-4 text-slate-400" />}
                <span className="flex-1 truncate">{it.file.name} <span className="text-xs text-slate-400">({(it.file.size / 1024).toFixed(0)} KB)</span></span>
                {it.status === 'done' && <Link className="text-indigo-600 hover:underline" to={`/invoices/${it.id}`}>View</Link>}
                {it.status === 'error' && <span className="text-xs text-red-600">{it.error}</span>}
                {it.status === 'queued' && <button aria-label="Remove" onClick={() => setItems((p) => p.filter((_, k) => k !== i))}><Trash2 className="h-4 w-4 text-slate-400 hover:text-red-500" /></button>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end"><Button disabled={!items.some((i) => i.status === 'queued')} onClick={run}>Upload & process</Button></div>
        <p className="mt-3 text-xs text-slate-500">After upload, extraction, validation, duplicate detection and your automation rules run in the background. Open the invoice to follow progress.</p>
      </div>
    </Card>
  );
}

function ManualTab() {
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<any>({ currency: 'INR', invoiceDate: new Date().toISOString().slice(0, 10) });
  const [lines, setLines] = useState([{ description: '', quantity: 1, unitPrice: 0 }]);
  const num = (x: any) => (x === '' || x === undefined ? undefined : Number(x));
  const sub = lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...v, subtotal: num(v.subtotal) ?? sub, tax: num(v.tax) ?? 0, total: num(v.total) ?? (num(v.subtotal) ?? sub) + (num(v.tax) ?? 0), dueDate: v.dueDate || undefined, purchaseOrderNumber: v.purchaseOrderNumber || undefined, lineItems: lines.filter((l) => l.description) };
      const r = await unwrap<any>(api.post('/invoices/manual', body));
      nav(`/invoices/${r.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const u = (k: string) => (e: any) => setV((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <Card>
      <div className="space-y-4 p-5">
        <p className="text-sm text-slate-500">Enter an invoice by hand. It goes through the same validation, duplicate detection and rules as uploaded invoices.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Invoice number"><input className="w-full" value={v.invoiceNumber ?? ''} onChange={u('invoiceNumber')} /></Field>
          <Field label="Vendor name"><input className="w-full" value={v.vendorName ?? ''} onChange={u('vendorName')} /></Field>
          <Field label="PO number"><input className="w-full" value={v.purchaseOrderNumber ?? ''} onChange={u('purchaseOrderNumber')} /></Field>
          <Field label="Invoice date"><input className="w-full" type="date" value={v.invoiceDate ?? ''} onChange={u('invoiceDate')} /></Field>
          <Field label="Due date"><input className="w-full" type="date" value={v.dueDate ?? ''} onChange={u('dueDate')} /></Field>
          <Field label="Currency"><input className="w-full" maxLength={3} value={v.currency} onChange={u('currency')} /></Field>
          <Field label="Subtotal" hint={`Defaults to line total (${sub.toFixed(2)})`}><input className="w-full" type="number" step="0.01" value={v.subtotal ?? ''} onChange={u('subtotal')} /></Field>
          <Field label="Tax"><input className="w-full" type="number" step="0.01" value={v.tax ?? ''} onChange={u('tax')} /></Field>
          <Field label="Total" hint="Defaults to subtotal + tax"><input className="w-full" type="number" step="0.01" value={v.total ?? ''} onChange={u('total')} /></Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Line items</p>
          {lines.map((l, i) => (
            <div key={i} className="mb-2 grid grid-cols-12 gap-2">
              <input className="col-span-6" placeholder="Description" value={l.description} onChange={(e) => setLines((p) => p.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} />
              <input className="col-span-2" type="number" min="0" step="any" value={l.quantity} onChange={(e) => setLines((p) => p.map((x, k) => (k === i ? { ...x, quantity: Number(e.target.value) } : x)))} aria-label="Quantity" />
              <input className="col-span-3" type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLines((p) => p.map((x, k) => (k === i ? { ...x, unitPrice: Number(e.target.value) } : x)))} aria-label="Unit price" />
              <button className="col-span-1 text-slate-400 hover:text-red-500" aria-label="Remove line" onClick={() => setLines((p) => p.filter((_, k) => k !== i))}><Trash2 className="mx-auto h-4 w-4" /></button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setLines((p) => [...p, { description: '', quantity: 1, unitPrice: 0 }])}><Plus className="h-3 w-3" /> Add line</Button>
        </div>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end"><Button loading={busy} onClick={submit}>Create & process</Button></div>
      </div>
    </Card>
  );
}

export default function UploadPage() {
  const [tab, setTab] = useState<'upload' | 'manual'>('upload');
  return (
    <>
      <PageHeader title="Add invoices" subtitle="Upload documents for AI extraction, or enter one manually." />
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 p-1 dark:border-slate-700">
        {(['upload', 'manual'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={cn('rounded-md px-4 py-1.5 text-sm font-medium', tab === t ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-300')}>{t === 'upload' ? 'Upload files' : 'Manual entry'}</button>)}
      </div>
      {tab === 'upload' ? <UploadTab /> : <ManualTab />}
    </>
  );
}
