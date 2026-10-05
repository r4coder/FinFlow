import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Trash2, XCircle } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, dateTime, pretty } from '../lib/utils';
import { Badge, Button, Card, Confirm, ErrorBox, Field, Modal, PageHeader, Spinner } from '../components/ui';

function AiSettings() {
  const { can, reload } = useAuth();
  const qc = useQueryClient();
  const editable = can('settings:ai');
  const q = useQuery({ queryKey: ['ai-settings'], queryFn: () => unwrap<any>(api.get('/settings/ai')) });
  const [mode, setMode] = useState<'MOCK' | 'GEMINI'>('MOCK');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<{ valid: boolean; reason?: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { if (q.data) { setMode(q.data.mode); setModel(q.data.model); } }, [q.data]);
  const validate = useMutation({ mutationFn: () => unwrap<any>(api.post('/settings/ai/validate', { apiKey: key })), onSuccess: (r) => { setCheck(r); setMsg(null); }, onError: (e) => setCheck({ valid: false, reason: errMsg(e) }) });
  const save = useMutation({
    mutationFn: () => unwrap<any>(api.put('/settings/ai', { mode, model, ...(key ? { apiKey: key } : {}) })),
    onSuccess: () => { setKey(''); setCheck(null); setMsg({ ok: true, text: 'AI settings saved.' }); qc.invalidateQueries({ queryKey: ['ai-settings'] }); reload(); },
    onError: (e) => setMsg({ ok: false, text: errMsg(e) }),
  });
  const del = useMutation({ mutationFn: () => api.delete('/settings/ai'), onSuccess: () => { setConfirmDel(false); setMsg({ ok: true, text: 'Key deleted. Switched to demo mode.' }); qc.invalidateQueries({ queryKey: ['ai-settings'] }); reload(); } });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <Card title="AI provider">
      <div className="max-w-2xl space-y-5 p-5">
        <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-950"><KeyRound className="h-5 w-5" /></div><div><p className="font-semibold">Google Gemini</p><p className="text-xs text-slate-500">Extracts structured data from invoice PDFs and images. Business rules, not the AI, make the decisions.</p></div></div>
        <fieldset className="space-y-2" disabled={!editable}>
          <legend className="mb-1 text-sm font-medium">AI mode</legend>
          {([['GEMINI', 'Gemini', 'Real extraction with your API key.'], ['MOCK', 'Demo / Mock', 'Deterministic sample extraction. No key and no network needed — everything else works the same.']] as const).map(([v, l, d]) => (
            <label key={v} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', mode === v ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20' : 'border-slate-200 dark:border-slate-700')}>
              <input type="radio" name="mode" className="mt-1" checked={mode === v} onChange={() => setMode(v)} /><span><b>{l}</b><br /><span className="text-xs text-slate-500">{d}</span></span>
            </label>
          ))}
        </fieldset>
        <Field label="Gemini API key" hint={q.data.hasKey ? 'A key is stored securely (encrypted). Enter a new one only to replace it.' : 'Create a key in Google AI Studio. It is sent to the server over HTTPS, encrypted at rest, and never shown again.'}>
          <div className="flex gap-2">
            <input className="w-full font-mono" type="password" autoComplete="off" spellCheck={false} placeholder={q.data.hasKey ? q.data.maskedKey : 'AIza…'} value={key} onChange={(e) => { setKey(e.target.value); setCheck(null); }} disabled={!editable} />
            <Button variant="secondary" disabled={!editable || key.length < 10} loading={validate.isPending} onClick={() => validate.mutate()}>Validate key</Button>
          </div>
        </Field>
        {check && <p role="status" className={cn('flex items-center gap-2 text-sm', check.valid ? 'text-emerald-600' : 'text-red-600')}>{check.valid ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{check.valid ? 'Key is valid.' : check.reason}</p>}
        <Field label="Gemini model" hint="Change if Google retires or renames a model."><input className="w-full sm:w-72" value={model} onChange={(e) => setModel(e.target.value)} disabled={!editable} /></Field>
        {msg && <p role="status" className={cn('text-sm', msg.ok ? 'text-emerald-600' : 'text-red-600')}>{msg.text}</p>}
        {editable ? (
          <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>{q.data.hasKey && <Button variant="danger" onClick={() => setConfirmDel(true)}><Trash2 className="h-4 w-4" /> Delete stored key</Button>}</div>
        ) : <p className="text-sm text-slate-500">Only owners and admins can change AI settings.</p>}
        <p className="text-xs text-slate-500">Current: <Badge color={q.data.mode === 'GEMINI' ? 'blue' : 'slate'}>{q.data.mode === 'GEMINI' ? 'Gemini' : 'Demo / Mock'}</Badge> {q.data.hasKey && <>· stored key <code>{q.data.maskedKey}</code></>}</p>
      </div>
      <Confirm open={confirmDel} danger title="Delete Gemini key?" confirmLabel="Delete key" loading={del.isPending} message="The stored key is permanently removed and AI mode switches to Demo / Mock." onConfirm={() => del.mutate()} onClose={() => setConfirmDel(false)} />
    </Card>
  );
}

function UsersSettings() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const manage = can('users:manage');
  const q = useQuery({ queryKey: ['users'], queryFn: () => unwrap<any[]>(api.get('/users')) });
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ fullName: '', email: '', password: '', role: 'FINANCE_USER' });
  const [err, setErr] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({ mutationFn: () => api.post('/users', form), onSuccess: () => { setAdd(false); setForm({ fullName: '', email: '', password: '', role: 'FINANCE_USER' }); refresh(); }, onError: (e) => setErr(errMsg(e)) });
  const role = useMutation({ mutationFn: (v: { id: string; role: string }) => api.patch(`/users/${v.id}/role`, { role: v.role }), onSuccess: refresh, onError: (e) => alert(errMsg(e)) });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/users/${id}`), onSuccess: refresh, onError: (e) => alert(errMsg(e)) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <Card title="Team members" action={manage ? <Button size="sm" onClick={() => setAdd(true)}>Add user</Button> : undefined}>
      <div className="overflow-x-auto"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th /></tr></thead><tbody>
        {q.data!.map((u) => (
          <tr key={u.id}><td className="font-medium">{u.fullName} {u.id === me?.id && <Badge color="indigo">You</Badge>}</td><td>{u.email}</td>
            <td>{manage && u.id !== me?.id ? <select value={u.role} onChange={(e) => role.mutate({ id: u.id, role: e.target.value })} aria-label={`Role for ${u.fullName}`}>{['OWNER', 'ADMIN', 'FINANCE_MANAGER', 'FINANCE_USER', 'VIEWER'].map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select> : <Badge>{pretty(u.role)}</Badge>}</td>
            <td className="text-xs text-slate-500">{dateTime(u.lastLoginAt)}</td><td className="text-right">{manage && u.id !== me?.id && u.role !== 'OWNER' && <Button size="sm" variant="ghost" aria-label={`Remove ${u.fullName}`} onClick={() => confirm(`Remove ${u.fullName}?`) && remove.mutate(u.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>}</td></tr>
        ))}
      </tbody></table></div>
      <Modal open={add} onClose={() => setAdd(false)} title="Add team member" footer={<><Button variant="secondary" onClick={() => setAdd(false)}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate()}>Create user</Button></>}>
        <div className="space-y-3">
          <Field label="Full name"><input className="w-full" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Work email"><input className="w-full" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="8+ characters with upper, lower case and a number"><input className="w-full" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role"><select className="w-full" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['ADMIN', 'FINANCE_MANAGER', 'FINANCE_USER', 'VIEWER'].map((r) => <option key={r} value={r}>{pretty(r)}</option>)}</select></Field>
          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        </div>
      </Modal>
    </Card>
  );
}

export default function Settings() {
  const { me } = useAuth();
  const [tab, setTab] = useState<'ai' | 'users' | 'org'>('ai');
  return (
    <>
      <PageHeader title="Settings" subtitle="AI provider, team and workspace." />
      <div className="mb-4 inline-flex rounded-lg border border-slate-200 p-1 text-sm dark:border-slate-700">
        {([['ai', 'AI'], ['users', 'Team'], ['org', 'Workspace']] as const).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={cn('rounded-md px-4 py-1.5 font-medium', tab === k ? 'bg-indigo-600 text-white' : 'text-slate-600 dark:text-slate-300')}>{l}</button>)}
      </div>
      {tab === 'ai' && <AiSettings />}
      {tab === 'users' && <UsersSettings />}
      {tab === 'org' && <Card title="Workspace"><dl className="grid max-w-xl grid-cols-2 gap-4 p-5 text-sm"><dt className="text-slate-500">Company</dt><dd className="font-medium">{me?.organization.name}</dd><dt className="text-slate-500">Your role</dt><dd className="font-medium">{pretty(me?.role)}</dd><dt className="text-slate-500">Your permissions</dt><dd className="text-xs">{me?.permissions.join(', ')}</dd></dl></Card>}
    </>
  );
}
