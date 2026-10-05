import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckSquare, ChevronDown, FileText, Gauge, History, LayoutDashboard, ListChecks, LogOut, Menu, Moon, Settings, ShieldAlert, Sun, Users, Workflow, BarChart3, ScrollText, Wand2 } from 'lucide-react';
import { api, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, dateTime } from '../lib/utils';
import { Button } from './ui';

const nav = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/invoices', label: 'Invoices', icon: FileText },
  { to: '/approvals', label: 'Approvals', icon: CheckSquare },
  { to: '/exceptions', label: 'Exceptions', icon: ShieldAlert },
  { to: '/vendors', label: 'Vendors', icon: Users },
];
const automation = [
  { to: '/automation/rules', label: 'Rules', icon: Workflow },
  { to: '/automation/templates', label: 'Rule Templates', icon: Wand2 },
  { to: '/automation/executions', label: 'Execution History', icon: History },
];
const tail = [
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/audit-logs', label: 'Audit Logs', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Item({ to, label, icon: Icon, sub }: { to: string; label: string; icon: any; sub?: boolean }) {
  return (
    <NavLink to={to} className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition', sub && 'ml-4 py-1.5', isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
      <Icon className="h-4 w-4" /> {label}
    </NavLink>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => unwrap<any>(api.get('/notifications', { params: { pageSize: 15 } })), refetchInterval: 15000 });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="Notifications" className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
        <Bell className="h-5 w-5" />
        {data?.unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{data.unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-96 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 dark:border-slate-800">
              <span className="text-sm font-semibold">Notifications</span>
              <button className="text-xs text-indigo-600 hover:underline" onClick={() => readAll.mutate()}>Mark all read</button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {!data?.items?.length && <p className="p-6 text-center text-sm text-slate-500">You're all caught up.</p>}
              {data?.items?.map((n: any) => (
                <button key={n.id} onClick={() => { read.mutate(n.id); setOpen(false); if (n.invoiceId) nav(`/invoices/${n.invoiceId}`); }} className={cn('block w-full border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800', !n.read && 'bg-indigo-50/50 dark:bg-indigo-950/30')}>
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-400">{n.message}</p>
                  <p className="mt-1 text-[11px] text-slate-400">{dateTime(n.createdAt)}</p>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function useTheme() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('if_theme', next ? 'dark' : 'light'); } catch { /* ignore */ }
    setDark(next);
  };
  return { dark, toggle };
}

export default function Layout() {
  const { me, logout } = useAuth();
  const [mobile, setMobile] = useState(false);
  const [autoOpen, setAutoOpen] = useState(true);
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen lg:flex">
      <aside className={cn('fixed inset-y-0 left-0 z-40 w-64 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-4 transition-transform dark:border-slate-800 dark:bg-slate-900 lg:static lg:translate-x-0', mobile ? 'translate-x-0' : '-translate-x-full')} onClick={() => setMobile(false)}>
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white"><Gauge className="h-5 w-5" /></div>
          <div>
            <p className="text-sm font-bold leading-tight">InvoiceFlow AI</p>
            <p className="text-[11px] leading-tight text-slate-500">{me?.organization.name}</p>
          </div>
        </div>
        <nav className="space-y-1">
          {nav.map((n) => <Item key={n.to} {...n} />)}
          <button onClick={(e) => { e.stopPropagation(); setAutoOpen((o) => !o); }} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            <span className="flex items-center gap-3"><ListChecks className="h-4 w-4" /> Automation</span>
            <ChevronDown className={cn('h-4 w-4 transition', autoOpen && 'rotate-180')} />
          </button>
          {autoOpen && automation.map((n) => <Item key={n.to} {...n} sub />)}
          {tail.map((n) => <Item key={n.to} {...n} />)}
        </nav>
      </aside>
      {mobile && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setMobile(false)} />}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <button className="rounded-lg p-2 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden" onClick={() => setMobile(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => navigate('/invoices/upload')}>Upload invoice</Button>
            <button onClick={toggle} aria-label="Toggle dark mode" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">{dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}</button>
            <Notifications />
            <div className="ml-2 hidden border-l border-slate-200 pl-3 text-right dark:border-slate-700 sm:block">
              <p className="text-sm font-medium leading-tight">{me?.fullName}</p>
              <p className="text-[11px] leading-tight text-slate-500">{me?.role.replace('_', ' ')}</p>
            </div>
            <button onClick={async () => { await logout(); navigate('/login'); }} aria-label="Log out" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"><LogOut className="h-5 w-5" /></button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
