import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#64748b'];
export const RISK_COLORS: Record<string, string> = { LOW: '#10b981', MEDIUM: '#f59e0b', HIGH: '#f97316', CRITICAL: '#ef4444' };
const STATUS_COLORS: Record<string, string> = { APPROVED: '#10b981', PAID: '#059669', PENDING_APPROVAL: '#f59e0b', MANUAL_REVIEW: '#f97316', REJECTED: '#ef4444', FAILED: '#b91c1c', UPLOADED: '#94a3b8', PROCESSING: '#3b82f6', EXTRACTED: '#60a5fa', VALIDATING: '#818cf8' };

const axis = { fontSize: 11, fill: '#94a3b8' };
const tip = { contentStyle: { borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 } };
const compact = (n: number) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const Box = ({ children, h = 240 }: { children: React.ReactElement; h?: number }) => <div style={{ height: h }} className="p-3"><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;

export const VolumeChart = ({ data }: { data: any[] }) => (
  <Box><BarChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} allowDecimals={false} /><Tooltip {...tip} /><Bar dataKey="invoices" name="Invoices" fill="#4f46e5" radius={[4, 4, 0, 0]} /></BarChart></Box>
);
export const SpendChart = ({ data }: { data: any[] }) => (
  <Box><LineChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} tickFormatter={compact} /><Tooltip {...tip} formatter={(v: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v)} /><Line type="monotone" dataKey="spend" name="Spend" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} /></LineChart></Box>
);
export const StatusChart = ({ data }: { data: { status: string; count: number }[] }) => (
  <Box><PieChart><Pie data={data} dataKey="count" nameKey="status" innerRadius={50} outerRadius={85} paddingAngle={2}>{data.map((d, i) => <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? COLORS[i % COLORS.length]} />)}</Pie><Tooltip {...tip} /><Legend wrapperStyle={{ fontSize: 11 }} /></PieChart></Box>
);
export const RiskChart = ({ data }: { data: { risk: string; count: number }[] }) => (
  <Box><BarChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="risk" tick={axis} /><YAxis tick={axis} allowDecimals={false} /><Tooltip {...tip} /><Bar dataKey="count" name="Invoices" radius={[4, 4, 0, 0]}>{data.map((d) => <Cell key={d.risk} fill={RISK_COLORS[d.risk]} />)}</Bar></BarChart></Box>
);
export const VendorChart = ({ data }: { data: { vendor: string; spend: number }[] }) => (
  <Box h={280}><BarChart data={data} layout="vertical" margin={{ left: 30 }}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis type="number" tick={axis} tickFormatter={compact} /><YAxis type="category" dataKey="vendor" tick={axis} width={150} /><Tooltip {...tip} formatter={(v: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v)} /><Bar dataKey="spend" name="Spend" fill="#06b6d4" radius={[0, 4, 4, 0]} /></BarChart></Box>
);
export const RateChart = ({ data, dataKey = 'automationRate', name = 'Automation rate %' }: { data: any[]; dataKey?: string; name?: string }) => (
  <Box><LineChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} domain={[0, 100]} /><Tooltip {...tip} /><Line type="monotone" dataKey={dataKey} name={name} stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} /></LineChart></Box>
);
export const ProcessingChart = ({ data }: { data: any[] }) => (
  <Box><LineChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} unit=" ms" /><Tooltip {...tip} /><Line type="monotone" dataKey="avgProcessingMs" name="Avg processing (ms)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls /></LineChart></Box>
);
export const FrequencyChart = ({ data }: { data: { day: string; count: number }[] }) => (
  <Box><BarChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f033" /><XAxis dataKey="day" tick={axis} tickFormatter={(d) => d.slice(5)} /><YAxis tick={axis} allowDecimals={false} /><Tooltip {...tip} /><Bar dataKey="count" name="Rule executions" fill="#4f46e5" radius={[4, 4, 0, 0]} /></BarChart></Box>
);
