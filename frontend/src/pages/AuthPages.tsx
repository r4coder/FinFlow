import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Gauge } from 'lucide-react';
import { api, errMsg, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field } from '../components/ui';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-slate-100 p-4 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-white"><Gauge className="h-7 w-7" /></div>
          <h1 className="text-2xl font-bold">InvoiceFlow AI</h1>
          <p className="text-sm text-slate-500">AI-Powered Invoice Processing & Business Automation Platform</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mb-5 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

const loginSchema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Password is required') });

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const f = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  return (
    <Shell title="Sign in" subtitle="Welcome back — sign in to your workspace.">
      <form className="space-y-4" onSubmit={f.handleSubmit(async (v) => { setErr(''); try { await login(v.email, v.password); nav('/dashboard'); } catch (e) { setErr(errMsg(e)); } })}>
        <Field label="Work email" error={f.formState.errors.email?.message}><input className="w-full" type="email" autoComplete="username" {...f.register('email')} /></Field>
        <Field label="Password" error={f.formState.errors.password?.message}><input className="w-full" type="password" autoComplete="current-password" {...f.register('password')} /></Field>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{err}</p>}
        <Button className="w-full" type="submit" loading={f.formState.isSubmitting}>Sign in</Button>
        <div className="flex justify-between text-sm"><Link className="text-indigo-600 hover:underline" to="/forgot-password">Forgot password?</Link><Link className="text-indigo-600 hover:underline" to="/register">Create a workspace</Link></div>
        <button type="button" className="w-full rounded-lg border border-dashed border-slate-300 p-2 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800" onClick={() => { f.setValue('email', 'admin@invoiceflow.demo'); f.setValue('password', 'Demo@12345'); }}>Fill demo credentials (admin@invoiceflow.demo)</button>
      </form>
    </Shell>
  );
}

const regSchema = z
  .object({
    fullName: z.string().min(2, 'Enter your full name'),
    email: z.string().email('Enter a valid email'),
    password: z.string().min(8, 'At least 8 characters').regex(/[a-z]/, 'Needs a lowercase letter').regex(/[A-Z]/, 'Needs an uppercase letter').regex(/[0-9]/, 'Needs a number'),
    confirmPassword: z.string(),
    companyName: z.string().min(2, 'Enter your company name'),
    industry: z.string().optional(),
    companySize: z.string().optional(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

export function RegisterPage() {
  const { register: signUp } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const f = useForm<z.infer<typeof regSchema>>({ resolver: zodResolver(regSchema), defaultValues: { industry: 'Manufacturing', companySize: '11-50' } });
  const e = f.formState.errors;
  return (
    <Shell title="Create your workspace" subtitle="Your company gets its own private workspace, rules and approval flow.">
      <form className="space-y-3" onSubmit={f.handleSubmit(async (v) => { setErr(''); try { await signUp(v); nav('/dashboard'); } catch (x) { setErr(errMsg(x)); } })}>
        <Field label="Full name" error={e.fullName?.message}><input className="w-full" autoComplete="name" {...f.register('fullName')} /></Field>
        <Field label="Work email" error={e.email?.message}><input className="w-full" type="email" autoComplete="username" {...f.register('email')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Password" error={e.password?.message}><input className="w-full" type="password" autoComplete="new-password" {...f.register('password')} /></Field>
          <Field label="Confirm password" error={e.confirmPassword?.message}><input className="w-full" type="password" autoComplete="new-password" {...f.register('confirmPassword')} /></Field>
        </div>
        <Field label="Company name" error={e.companyName?.message}><input className="w-full" {...f.register('companyName')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Industry"><select className="w-full" {...f.register('industry')}>{['Manufacturing', 'Retail', 'Technology', 'Healthcare', 'Logistics', 'Professional Services', 'Hospitality', 'Other'].map((i) => <option key={i}>{i}</option>)}</select></Field>
          <Field label="Company size"><select className="w-full" {...f.register('companySize')}>{['1-10', '11-50', '51-200', '201-1000', '1000+'].map((i) => <option key={i}>{i}</option>)}</select></Field>
        </div>
        {err && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{err}</p>}
        <Button className="w-full" type="submit" loading={f.formState.isSubmitting}>Create workspace</Button>
        <p className="text-center text-sm text-slate-500">Already have an account? <Link className="text-indigo-600 hover:underline" to="/login">Sign in</Link></p>
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [res, setRes] = useState<{ message: string; devResetLink?: string } | null>(null);
  const [err, setErr] = useState('');
  return (
    <Shell title="Reset your password" subtitle="Enter your email and we'll generate a reset link.">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { setRes(await unwrap(api.post('/auth/forgot-password', { email }))); } catch (x) { setErr(errMsg(x)); } }}>
        <Field label="Work email"><input className="w-full" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {res && (
          <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            {res.message}
            {res.devResetLink && <p className="mt-2 break-all text-xs">Development mode (no email server configured): <a className="underline" href={res.devResetLink}>open reset link</a></p>}
          </div>
        )}
        <Button className="w-full" type="submit">Send reset link</Button>
        <p className="text-center text-sm"><Link className="text-indigo-600 hover:underline" to="/login">Back to sign in</Link></p>
      </form>
    </Shell>
  );
}

export function ResetPasswordPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  return (
    <Shell title="Choose a new password" subtitle="Use at least 8 characters with upper, lower case and a number.">
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.post('/auth/reset-password', { token: sp.get('token'), password }); nav('/login'); } catch (x) { setErr(errMsg(x)); } }}>
        <Field label="New password"><input className="w-full" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <Button className="w-full" type="submit">Reset password</Button>
      </form>
    </Shell>
  );
}
