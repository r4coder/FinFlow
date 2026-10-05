import { Navigate, Route, Routes } from 'react-router-dom';
import { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import Dashboard from './pages/Dashboard';
import Invoices from './pages/Invoices';
import UploadPage from './pages/Upload';
import InvoiceDetail from './pages/InvoiceDetail';
import Approvals from './pages/Approvals';
import Exceptions from './pages/Exceptions';
import Vendors from './pages/Vendors';
import { RulesPage, TemplatesPage } from './pages/Rules';
import RuleBuilder from './pages/RuleBuilder';
import Executions from './pages/Executions';
import Analytics from './pages/Analytics';
import AuditLogs from './pages/AuditLogs';
import Settings from './pages/Settings';

function Protected({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner label="Loading workspace…" />;
  return me ? <>{children}</> : <Navigate to="/login" replace />;
}
function Public({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return me ? <Navigate to="/dashboard" replace /> : <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Public><LoginPage /></Public>} />
      <Route path="/register" element={<Public><RegisterPage /></Public>} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<Protected><Layout /></Protected>}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/invoices/upload" element={<UploadPage />} />
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/exceptions" element={<Exceptions />} />
        <Route path="/vendors" element={<Vendors />} />
        <Route path="/automation" element={<Navigate to="/automation/rules" replace />} />
        <Route path="/automation/rules" element={<RulesPage />} />
        <Route path="/automation/rules/new" element={<RuleBuilder key="new" />} />
        <Route path="/automation/rules/:id" element={<RuleBuilder />} />
        <Route path="/automation/templates" element={<TemplatesPage />} />
        <Route path="/automation/executions" element={<Executions />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/audit-logs" element={<AuditLogs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
