import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Check, FlaskConical, FolderPlus, Plus, Save, Trash2, X } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, dateTime, money } from '../lib/utils';
import { Badge, Button, Card, ErrorBox, Field, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { RuleTrace } from '../components/RuleTrace';

type Leaf = { field: string; operator: string; value: any };
type Group = { operator: 'AND' | 'OR'; conditions: (Leaf | Group)[] };
const isGroup = (n: any): n is Group => n && 'conditions' in n;

interface Meta {
  fields: { key: string; label: string; type: string; group: string; operators: { key: string; label: string }[]; options: string[] | null; help: string | null }[];
  triggers: { key: string; label: string; allowsDecisionActions: boolean }[];
  actions: { type: string; label: string; kind: 'decision' | 'effect' }[];
}

const ROLES = [['FINANCE_MANAGER', 'Finance Manager'], ['ADMIN', 'Admin'], ['OWNER', 'Owner']];
const RECIPIENTS = [['UPLOADER', 'Uploader'], ['FINANCE_MANAGER', 'Finance Manager'], ['ADMIN', 'Admin'], ['OWNER', 'Owner'], ['USER', 'Specific user']];
const DEFAULT_LEAF: Leaf = { field: 'invoice.total', operator: 'greater_than', value: 50000 };

function defaultValue(meta: Meta, field: string): any {
  const f = meta.fields.find((x) => x.key === field)!;
  return f.type === 'number' ? 0 : f.type === 'boolean' ? true : f.type === 'risk' ? 'HIGH' : f.type === 'date' ? new Date().toISOString().slice(0, 10) : '';
}

// ---------------------------------------------------------------------------------------------------------------------
// Condition tree editor
// ---------------------------------------------------------------------------------------------------------------------
function LeafEditor({ node, meta, vendors, onChange, onRemove }: { node: Leaf; meta: Meta; vendors: any[]; onChange: (n: Leaf) => void; onRemove: () => void }) {
  const def = meta.fields.find((f) => f.key === node.field)!;
  const groups = [...new Set(meta.fields.map((f) => f.group))];
  const setField = (field: string) => {
    const nd = meta.fields.find((f) => f.key === field)!;
    onChange({ field, operator: nd.operators.some((o) => o.key === node.operator) ? node.operator : nd.operators[0].key, value: defaultValue(meta, field) });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
      <select aria-label="Field" value={node.field} onChange={(e) => setField(e.target.value)} className="min-w-44">
        {groups.map((g) => <optgroup key={g} label={g}>{meta.fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}
      </select>
      <select aria-label="Operator" value={node.operator} onChange={(e) => onChange({ ...node, operator: e.target.value })}>
        {def.operators.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {def.type === 'number' && <input aria-label="Value" type="number" step="any" className="w-36" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value === '' ? '' : Number(e.target.value) })} />}
      {def.type === 'date' && <input aria-label="Value" type="date" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })} />}
      {def.type === 'boolean' && <select aria-label="Value" value={String(node.value)} onChange={(e) => onChange({ ...node, value: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></select>}
      {def.type === 'risk' && <select aria-label="Value" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })}>{def.options!.map((o) => <option key={o}>{o}</option>)}</select>}
      {def.type === 'string' && node.field === 'vendor.id' ? (
        <select aria-label="Value" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })}><option value="">Select vendor…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
      ) : def.type === 'string' ? <input aria-label="Value" className="w-48" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })} /> : null}
      {def.help && <span className="text-xs text-slate-400">{def.help}</span>}
      <button type="button" onClick={onRemove} aria-label="Remove condition" className="ml-auto rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><X className="h-4 w-4" /></button>
    </div>
  );
}

function GroupEditor({ node, meta, vendors, onChange, onRemove, depth = 0 }: { node: Group; meta: Meta; vendors: any[]; onChange: (n: Group) => void; onRemove?: () => void; depth?: number }) {
  const setChild = (i: number, c: Leaf | Group) => onChange({ ...node, conditions: node.conditions.map((x, k) => (k === i ? c : x)) });
  const rmChild = (i: number) => onChange({ ...node, conditions: node.conditions.filter((_, k) => k !== i) });
  return (
    <div className={cn('rounded-xl border-2 p-3', node.operator === 'AND' ? 'border-indigo-200 bg-indigo-50/40 dark:border-indigo-900 dark:bg-indigo-950/20' : 'border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20')}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase text-slate-500">{depth === 0 ? 'Match' : 'Group'}</span>
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 dark:border-slate-600 dark:bg-slate-900" role="group" aria-label="Match mode">
          {(['AND', 'OR'] as const).map((op) => <button key={op} type="button" onClick={() => onChange({ ...node, operator: op })} className={cn('rounded-md px-3 py-1 text-xs font-bold', node.operator === op ? (op === 'AND' ? 'bg-indigo-600 text-white' : 'bg-amber-500 text-white') : 'text-slate-500')}>{op === 'AND' ? 'ALL (AND)' : 'ANY (OR)'}</button>)}
        </div>
        <span className="text-xs text-slate-500">{node.operator === 'AND' ? 'every condition below must be true' : 'at least one condition must be true'}</span>
        {onRemove && <button type="button" onClick={onRemove} className="ml-auto text-xs text-red-600 hover:underline">Remove group</button>}
      </div>
      <div className="space-y-2">
        {node.conditions.map((c, i) => (
          <div key={i}>
            {i > 0 && <div className="my-1 flex items-center gap-2"><span className={cn('rounded px-2 py-0.5 text-[10px] font-bold', node.operator === 'AND' ? 'bg-indigo-600 text-white' : 'bg-amber-500 text-white')}>{node.operator}</span><span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /></div>}
            {isGroup(c) ? <GroupEditor node={c} meta={meta} vendors={vendors} depth={depth + 1} onChange={(n) => setChild(i, n)} onRemove={() => rmChild(i)} /> : <LeafEditor node={c} meta={meta} vendors={vendors} onChange={(n) => setChild(i, n)} onRemove={() => rmChild(i)} />}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...node, conditions: [...node.conditions, { ...DEFAULT_LEAF }] })}><Plus className="h-3 w-3" /> Condition</Button>
        {depth < 3 && <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...node, conditions: [...node.conditions, { operator: 'AND', conditions: [{ ...DEFAULT_LEAF }] }] })}><FolderPlus className="h-3 w-3" /> Group</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Action editor
// ---------------------------------------------------------------------------------------------------------------------
function ApproverPicker({ value, users, onChange }: { value: any; users: any[]; onChange: (v: any) => void }) {
  const mode = value.userId ? 'USER' : 'ROLE';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Approver type" value={mode} onChange={(e) => onChange(e.target.value === 'USER' ? { userId: users[0]?.id } : { role: 'FINANCE_MANAGER' })}><option value="ROLE">Role</option><option value="USER">Specific user</option></select>
      {mode === 'ROLE' ? <select aria-label="Approver role" value={value.role} onChange={(e) => onChange({ role: e.target.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select> : <select aria-label="Approver user" value={value.userId ?? ''} onChange={(e) => onChange({ userId: e.target.value })}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName} ({u.email})</option>)}</select>}
    </div>
  );
}

function newAction(type: string): any {
  switch (type) {
    case 'REQUIRE_APPROVAL': return { type, role: 'FINANCE_MANAGER' };
    case 'REQUIRE_MULTI_LEVEL_APPROVAL': return { type, levels: [{ role: 'FINANCE_MANAGER' }, { role: 'ADMIN' }] };
    case 'REJECT_INVOICE': return { type, reason: 'Rejected by automation rule' };
    case 'SEND_NOTIFICATION': return { type, recipient: 'FINANCE_MANAGER', message: 'Invoice {{invoiceNumber}} requires attention. Vendor: {{vendorName}}. Amount: {{total}}.' };
    case 'CREATE_TASK': return { type, title: 'Review invoice {{invoiceNumber}}', priority: 'HIGH', assignTo: 'FINANCE_MANAGER', dueInDays: 2 };
    case 'ADD_TAG': return { type, tag: 'High Value' };
    case 'MOVE_TO_EXCEPTION_QUEUE': case 'REQUEST_HUMAN_REVIEW': return { type, reason: '' };
    case 'SET_RISK_LEVEL': return { type, level: 'HIGH' };
    case 'UPDATE_STATUS': return { type, status: 'MANUAL_REVIEW' };
    default: return { type };
  }
}

function ActionEditor({ a, users, onChange, onRemove, options }: { a: any; users: any[]; onChange: (a: any) => void; onRemove: () => void; options: Meta['actions'] }) {
  const set = (p: any) => onChange({ ...a, ...p });
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2">
        <select aria-label="Action" value={a.type} onChange={(e) => onChange(newAction(e.target.value))} className="min-w-64 font-medium">
          <optgroup label="Decisions (what happens to the invoice)">{options.filter((o) => o.kind === 'decision').map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}</optgroup>
          <optgroup label="Side effects">{options.filter((o) => o.kind === 'effect').map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}</optgroup>
        </select>
        <button type="button" onClick={onRemove} aria-label="Remove action" className="ml-auto rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
      </div>
      <div className="mt-3 space-y-2 text-sm">
        {a.type === 'REQUIRE_APPROVAL' && <ApproverPicker value={a} users={users} onChange={(v) => onChange({ type: a.type, ...v })} />}
        {a.type === 'REQUIRE_MULTI_LEVEL_APPROVAL' && (
          <div className="space-y-2">
            {a.levels.map((l: any, i: number) => (
              <div key={i} className="flex flex-wrap items-center gap-2"><Badge color="indigo">Level {i + 1}</Badge><ApproverPicker value={l} users={users} onChange={(v) => set({ levels: a.levels.map((x: any, k: number) => (k === i ? v : x)) })} />{a.levels.length > 2 && <button type="button" aria-label="Remove level" onClick={() => set({ levels: a.levels.filter((_: any, k: number) => k !== i) })}><X className="h-4 w-4 text-slate-400" /></button>}</div>
            ))}
            {a.levels.length < 5 && <Button type="button" size="sm" variant="secondary" onClick={() => set({ levels: [...a.levels, { role: 'ADMIN' }] })}>Add level</Button>}
          </div>
        )}
        {a.type === 'REJECT_INVOICE' && <Field label="Rejection reason"><input className="w-full" value={a.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} /></Field>}
        {(a.type === 'MOVE_TO_EXCEPTION_QUEUE' || a.type === 'REQUEST_HUMAN_REVIEW') && <Field label="Reason shown to reviewers (optional)"><input className="w-full" value={a.reason ?? ''} onChange={(e) => set({ reason: e.target.value })} /></Field>}
        {a.type === 'SEND_NOTIFICATION' && (
          <>
            <div className="flex flex-wrap gap-2"><Field label="Recipient"><select value={a.recipient} onChange={(e) => set({ recipient: e.target.value, userId: e.target.value === 'USER' ? users[0]?.id : undefined })}>{RECIPIENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>{a.recipient === 'USER' && <Field label="User"><select value={a.userId ?? ''} onChange={(e) => set({ userId: e.target.value })}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></Field>}</div>
            <Field label="Message" hint="Variables: {{invoiceNumber}} {{vendorName}} {{total}} {{currency}} {{riskLevel}} {{ruleName}} {{dueDate}}"><textarea className="w-full" rows={2} value={a.message ?? ''} onChange={(e) => set({ message: e.target.value })} /></Field>
          </>
        )}
        {a.type === 'CREATE_TASK' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Title" hint="Supports {{variables}}"><input className="w-full" value={a.title} onChange={(e) => set({ title: e.target.value })} /></Field></div>
            <Field label="Priority"><select className="w-full" value={a.priority} onChange={(e) => set({ priority: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH'].map((p) => <option key={p}>{p}</option>)}</select></Field>
            <Field label="Due in (days)"><input className="w-full" type="number" min={0} max={90} value={a.dueInDays} onChange={(e) => set({ dueInDays: Number(e.target.value) })} /></Field>
            <Field label="Assign to"><select className="w-full" value={a.assignTo} onChange={(e) => set({ assignTo: e.target.value, userId: e.target.value === 'USER' ? users[0]?.id : undefined })}>{RECIPIENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            {a.assignTo === 'USER' && <Field label="User"><select className="w-full" value={a.userId ?? ''} onChange={(e) => set({ userId: e.target.value })}>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></Field>}
          </div>
        )}
        {a.type === 'ADD_TAG' && <Field label="Tag"><input className="w-full sm:w-64" value={a.tag} onChange={(e) => set({ tag: e.target.value })} /></Field>}
        {a.type === 'SET_RISK_LEVEL' && <Field label="Risk level"><select value={a.level} onChange={(e) => set({ level: e.target.value })}>{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((r) => <option key={r}>{r}</option>)}</select></Field>}
        {a.type === 'UPDATE_STATUS' && <Field label="Set status to" hint="PAID is only allowed for already-approved invoices"><select value={a.status} onChange={(e) => set({ status: e.target.value })}><option>MANUAL_REVIEW</option><option>PAID</option></select></Field>}
        {a.type === 'AUTO_APPROVE' && <p className="text-xs text-slate-500">The invoice is approved with no human step. Combine with strict conditions (low value, low risk, high AI confidence).</p>}
        {a.type === 'TRIGGER_AI_ANALYSIS' && <p className="text-xs text-slate-500">Re-runs the AI risk explanation after the decision. It never changes the decision.</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------------------------------
interface Draft { name: string; description: string; enabled: boolean; priority: number; trigger: string; conditions: Group; actions: any[]; templateKey?: string | null }

export default function RuleBuilder() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = can('rule:write');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [testInvoice, setTestInvoice] = useState('');
  const [result, setResult] = useState<any>(null);
  const [testErr, setTestErr] = useState('');

  const meta = useQuery({ queryKey: ['rule-meta'], queryFn: () => unwrap<Meta>(api.get('/automation/metadata')) });
  const templates = useQuery({ queryKey: ['rule-templates'], queryFn: () => unwrap<any[]>(api.get('/automation/templates')), enabled: !!sp.get('template') });
  const rule = useQuery({ queryKey: ['rule', id], queryFn: () => unwrap<any>(api.get(`/automation/rules/${id}`)), enabled: !!id });
  const versions = useQuery({ queryKey: ['rule-versions', id], queryFn: () => unwrap<any[]>(api.get(`/automation/rules/${id}/versions`)), enabled: !!id });
  const users = useQuery({ queryKey: ['users'], queryFn: () => unwrap<any[]>(api.get('/users')) });
  const vendors = useQuery({ queryKey: ['vendors-all'], queryFn: () => unwrap<any>(api.get('/vendors', { params: { pageSize: 200 } })) });
  const invoices = useQuery({ queryKey: ['invoices-test'], queryFn: () => unwrap<any>(api.get('/invoices', { params: { pageSize: 50 } })) });

  useEffect(() => {
    if (draft) return;
    if (id && rule.data) setDraft({ name: rule.data.name, description: rule.data.description ?? '', enabled: rule.data.enabled, priority: rule.data.priority, trigger: rule.data.trigger, conditions: rule.data.conditions, actions: rule.data.actions, templateKey: rule.data.templateKey });
    else if (!id && !sp.get('template')) setDraft({ name: '', description: '', enabled: true, priority: 50, trigger: 'INVOICE_PROCESSED', conditions: { operator: 'AND', conditions: [{ ...DEFAULT_LEAF }] }, actions: [newAction('REQUIRE_APPROVAL')] });
    else if (!id && templates.data) {
      const t = templates.data.find((x) => x.key === sp.get('template'));
      if (t) setDraft({ name: t.name, description: t.description, enabled: true, priority: t.priority, trigger: t.trigger, conditions: t.conditions, actions: t.actions, templateKey: t.key });
    }
  }, [id, rule.data, templates.data, sp, draft]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...draft, description: draft!.description || null };
      return id ? unwrap<any>(api.patch(`/automation/rules/${id}`, body)) : unwrap<any>(api.post('/automation/rules', body));
    },
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['rule', id] }); qc.invalidateQueries({ queryKey: ['rule-versions', id] }); setErr(''); setSaved(true); setTimeout(() => setSaved(false), 2500); if (!id) nav(`/automation/rules/${r.id}`, { replace: true }); },
    onError: (e) => { setErr(errMsg(e)); setSaved(false); },
  });
  const test = useMutation({
    mutationFn: () => unwrap<any>(api.post('/automation/rules/test-draft', { ...draft, invoiceId: testInvoice })),
    onSuccess: (r) => { setResult(r); setTestErr(''); },
    onError: (e) => { setTestErr(errMsg(e)); setResult(null); },
  });

  const m = meta.data;
  const trig = useMemo(() => m?.triggers.find((t) => t.key === draft?.trigger), [m, draft?.trigger]);
  if (meta.isLoading || (id && rule.isLoading) || !draft || !m) return rule.error ? <ErrorBox error={rule.error} /> : <Spinner />;
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d!, ...p }));
  const actionOptions = m.actions.filter((a) => trig?.allowsDecisionActions || a.kind === 'effect');
  const changeTrigger = (t: string) => {
    const allows = m.triggers.find((x) => x.key === t)!.allowsDecisionActions;
    set({ trigger: t, actions: allows ? draft.actions : draft.actions.filter((a) => m.actions.find((o) => o.type === a.type)?.kind === 'effect') });
  };

  return (
    <>
      <PageHeader title={id ? `Edit rule${rule.data ? ` · v${rule.data.version}` : ''}` : 'Create automation rule'} subtitle="Decide what happens to an invoice — no code required." actions={<>
        <Button variant="secondary" onClick={() => nav('/automation/rules')}>Back to rules</Button>
        {editable && <Button loading={save.isPending} onClick={() => save.mutate()}><Save className="h-4 w-4" /> Save rule</Button>}
      </>} />
      {err && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{err}</div>}
      {saved && <div role="status" className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Check className="h-4 w-4" /> Rule saved{id ? ' — a new version was recorded' : ''}.</div>}
      {!editable && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">You have read-only access. You can still test this rule.</p>}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-2 xl:col-span-2">
          <Card><div className="grid gap-3 p-5 sm:grid-cols-3">
            <div className="sm:col-span-2"><Field label="Rule name"><input className="w-full" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="High Value Invoice Approval" disabled={!editable} /></Field></div>
            <Field label="Priority" hint="1 runs first and wins conflicts"><input className="w-full" type="number" min={1} value={draft.priority} onChange={(e) => set({ priority: Number(e.target.value) })} disabled={!editable} /></Field>
            <div className="sm:col-span-3"><Field label="Description"><input className="w-full" value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Require manager approval for high-value invoices" disabled={!editable} /></Field></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={!editable} /> Rule is enabled</label>
          </div></Card>

          <fieldset disabled={!editable} className="space-y-2 disabled:opacity-80">
            <div className="rounded-xl border-l-4 border-blue-500 bg-white p-5 shadow-sm dark:bg-slate-900">
              <p className="mb-2 text-xs font-bold uppercase tracking-widest text-blue-600">When</p>
              <select aria-label="Trigger" className="w-full sm:w-80" value={draft.trigger} onChange={(e) => changeTrigger(e.target.value)}>{m.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
              {!trig?.allowsDecisionActions && <p className="mt-2 text-xs text-slate-500">This event happens after a decision was made, so only side-effect actions (notify, tag, task…) are available.</p>}
            </div>
            <div className="flex justify-center"><ArrowDown className="h-5 w-5 text-slate-300" /></div>
            <div className="rounded-xl border-l-4 border-indigo-500 bg-white p-5 shadow-sm dark:bg-slate-900">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-indigo-600">If</p>
              <GroupEditor node={draft.conditions} meta={m} vendors={vendors.data?.items ?? []} onChange={(c) => set({ conditions: c })} />
            </div>
            <div className="flex justify-center"><ArrowDown className="h-5 w-5 text-slate-300" /></div>
            <div className="rounded-xl border-l-4 border-emerald-500 bg-white p-5 shadow-sm dark:bg-slate-900">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-emerald-600">Then</p>
              <div className="space-y-2">
                {draft.actions.map((a, i) => (
                  <div key={i}>
                    {i > 0 && <p className="my-1 text-center text-[10px] font-bold uppercase tracking-widest text-slate-400">and</p>}
                    <ActionEditor a={a} users={users.data ?? []} options={actionOptions} onChange={(n) => set({ actions: draft.actions.map((x, k) => (k === i ? n : x)) })} onRemove={() => set({ actions: draft.actions.filter((_, k) => k !== i) })} />
                  </div>
                ))}
              </div>
              <Button type="button" className="mt-3" size="sm" variant="secondary" onClick={() => set({ actions: [...draft.actions, newAction(actionOptions.find((o) => o.kind === 'effect')?.type ?? 'ADD_TAG')] })}><Plus className="h-3 w-3" /> Add action</Button>
            </div>
          </fieldset>

          <Card title="How conflicts are resolved">
            <ul className="list-inside list-disc space-y-1 p-5 text-xs text-slate-600 dark:text-slate-300">
              <li>Rules run in priority order (1 first). The highest-priority matching <b>decision</b> action decides the invoice.</li>
              <li>If several decisions share the same priority, the most restrictive wins: Reject &gt; Manual review &gt; Approval &gt; Auto-approve.</li>
              <li>Side effects (notify, tag, task…) from every matching rule still run.</li>
              <li>Safety floor: duplicates and arithmetic errors can never be auto-approved, whatever the rules say. AI never overrides your rules.</li>
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Test rule (dry run)</span>}>
            <div className="space-y-3 p-5">
              <p className="text-xs text-slate-500">Evaluate this rule — even unsaved — against a real invoice. <b>Nothing is executed or changed.</b></p>
              <select className="w-full" aria-label="Invoice to test against" value={testInvoice} onChange={(e) => { setTestInvoice(e.target.value); setResult(null); }}>
                <option value="">Choose an invoice…</option>
                {invoices.data?.items.map((i: any) => <option key={i.id} value={i.id}>{i.invoiceNumber ?? i.fileName} · {i.vendor?.name ?? '—'} · {money(i.total, i.currency)}</option>)}
              </select>
              <Button className="w-full" disabled={!testInvoice} loading={test.isPending} onClick={() => test.mutate()}>Test rule</Button>
              {testErr && <p role="alert" className="text-sm text-red-600">{testErr}</p>}
              {result && (
                <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <p className="text-sm font-semibold">Invoice {result.invoice.invoiceNumber} · {money(result.invoice.total, result.invoice.currency)} · risk {result.invoice.riskLevel ?? '—'}</p>
                  <RuleTrace node={result.trace} />
                  <p className="text-sm">Final result: <Badge color={result.matched ? 'green' : 'slate'}>{result.matched ? 'MATCH' : 'NO MATCH'}</Badge></p>
                  {result.matched && <div><p className="mb-1 text-xs font-semibold uppercase text-slate-500">Actions that would execute</p><ul className="space-y-1 text-sm">{result.actionDetails.map((a: any, i: number) => <li key={i} className="flex items-center gap-2"><Check className="h-4 w-4 text-emerald-500" />{a.description}</li>)}</ul></div>}
                  {result.decisionPreview && <p className="rounded-lg bg-slate-50 p-2 text-xs dark:bg-slate-800">With your other active rules, this invoice would end as <b>{result.decisionPreview.disposition.replace('_', ' ')}</b> (decided by “{result.decisionPreview.decidedBy}”).</p>}
                  <p className="text-xs italic text-slate-400">{result.note}</p>
                </div>
              )}
            </div>
          </Card>
          {id && (
            <Card title="Version history">
              {versions.isLoading ? <Spinner /> : (
                <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                  {versions.data?.map((v) => (
                    <li key={v.id} className="px-5 py-3 text-sm">
                      <div className="flex items-center justify-between"><Badge color="indigo">Version {v.version}</Badge><span className="text-xs text-slate-400">{dateTime(v.changedAt)}</span></div>
                      <p className="mt-1">{v.changeSummary}</p>
                      <p className="text-xs text-slate-500">Changed by {v.changedByName ?? 'unknown'}</p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
          {rule.data && <Card><div className="p-5 text-xs text-slate-500">Status <StatusBadge value={rule.data.enabled ? 'APPROVED' : 'CANCELLED'} /> · executions {rule.data.executionCount ?? 0}</div></Card>}
        </div>
      </div>
    </>
  );
}
