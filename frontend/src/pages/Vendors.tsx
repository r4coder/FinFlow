import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/utils';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHeader, Pagination, Spinner } from '../components/ui';

function VendorModal({ vendor, onClose }: { vendor: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<any>(vendor ?? { name: '', email: '', phone: '', address: '', taxId: '', paymentTerms: '', industry: '', group: '', verified: true });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const body = Object.fromEntries(['name', 'email', 'phone', 'address', 'taxId', 'paymentTerms', 'industry', 'group'].map((k) => [k, v[k] === '' || v[k] === undefined ? null : v[k]]));
      return vendor?.id ? api.patch(`/vendors/${vendor.id}`, { ...body, verified: v.verified }) : api.post('/vendors', { ...body, verified: v.verified });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vendors'] }); onClose(); },
    onError: (e) => setErr(errMsg(e)),
  });
  const u = (k: string) => (e: any) => setV((p: any) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={vendor?.id ? 'Edit vendor' : 'New vendor'} wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!v.name} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="w-full" value={v.name ?? ''} onChange={u('name')} /></Field>
        <Field label="Tax ID"><input className="w-full" value={v.taxId ?? ''} onChange={u('taxId')} /></Field>
        <Field label="Email"><input className="w-full" type="email" value={v.email ?? ''} onChange={u('email')} /></Field>
        <Field label="Phone"><input className="w-full" value={v.phone ?? ''} onChange={u('phone')} /></Field>
        <Field label="Industry" hint="Usable in rules (vendor.industry)"><input className="w-full" value={v.industry ?? ''} onChange={u('industry')} /></Field>
        <Field label="Vendor group" hint="Usable in rules (vendor.group), e.g. preferred"><input className="w-full" value={v.group ?? ''} onChange={u('group')} /></Field>
        <Field label="Payment terms"><input className="w-full" value={v.paymentTerms ?? ''} onChange={u('paymentTerms')} /></Field>
        <Field label="Address"><input className="w-full" value={v.address ?? ''} onChange={u('address')} /></Field>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={!!v.verified} onChange={(e) => setV((p: any) => ({ ...p, verified: e.target.checked }))} /> Verified vendor (unverified vendors raise risk)</label>
      <p className="mt-3 text-xs text-slate-500">Bank details are intentionally not stored.</p>
      {err && <p role="alert" className="mt-2 text-sm text-red-600">{err}</p>}
    </Modal>
  );
}

export default function Vendors() {
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<any | false>(false);
  const q = useQuery({ queryKey: ['vendors', search, page], queryFn: () => unwrap<any>(api.get('/vendors', { params: { search, page, pageSize: 20 } })) });
  return (
    <>
      <PageHeader title="Vendors" subtitle="Your vendor master. Vendors found on invoices are added automatically as unverified." actions={can('vendor:write') ? <Button onClick={() => setModal({})}><Plus className="h-4 w-4" /> New vendor</Button> : undefined} />
      <Card>
        <div className="border-b border-slate-100 p-4 dark:border-slate-800"><input className="w-full sm:w-80" placeholder="Search vendors…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search vendors" /></div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data.items.length ? <Empty title="No vendors" /> : (
          <div className="overflow-x-auto"><table><thead><tr><th>Name</th><th>Industry</th><th>Group</th><th>Tax ID</th><th>Invoices</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>
            {q.data.items.map((v: any) => <tr key={v.id}><td className="font-medium">{v.name}</td><td>{v.industry ?? '—'}</td><td>{v.group ?? '—'}</td><td>{v.taxId ?? '—'}</td><td>{v.invoiceCount}</td><td className="tabular-nums">{money(v.totalSpend)}</td><td>{v.verified ? <Badge color="green">Verified</Badge> : <Badge color="amber">Unverified</Badge>}</td><td className="text-right">{can('vendor:write') && <Button size="sm" variant="secondary" onClick={() => setModal(v)}>Edit</Button>}</td></tr>)}
          </tbody></table></div>
        )}
        <Pagination meta={q.data?.meta} onPage={setPage} />
      </Card>
      {modal !== false && <VendorModal vendor={modal.id ? modal : null} onClose={() => setModal(false)} />}
    </>
  );
}
