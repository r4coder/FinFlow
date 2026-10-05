import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ok, renderPage } from './utils';

const get = vi.fn();
const post = vi.fn();
const login = vi.fn();
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<any>('../lib/api');
  return { ...actual, api: { get: (...a: any[]) => get(...a), post: (...a: any[]) => post(...a), patch: vi.fn(), delete: vi.fn() } };
});
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ me: { id: 'u1', fullName: 'Rahul Verma', role: 'OWNER', permissions: [], organization: { name: 'Demo' } }, can: () => true, login, register: vi.fn() }),
}));

import { LoginPage, RegisterPage } from '../pages/AuthPages';
import Dashboard from '../pages/Dashboard';
import { RulesPage } from '../pages/Rules';
import Invoices from '../pages/Invoices';
import { RuleTrace } from '../components/RuleTrace';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  login.mockReset();
});

describe('auth forms', () => {
  it('validates login fields before calling the API, then submits', async () => {
    const user = userEvent.setup();
    login.mockResolvedValue(undefined);
    renderPage(<LoginPage />);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Work email/), 'a@b.co');
    await user.type(screen.getByLabelText(/^Password/), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('a@b.co', 'secret'));
  });

  it('shows the server error on bad credentials', async () => {
    const user = userEvent.setup();
    login.mockRejectedValue({ response: { data: { error: { message: 'Invalid email or password' } } } });
    renderPage(<LoginPage />);
    await user.type(screen.getByLabelText('Work email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('registration enforces password strength and confirmation', async () => {
    const user = userEvent.setup();
    renderPage(<RegisterPage />);
    await user.type(screen.getByLabelText('Full name'), 'Jane Doe');
    await user.type(screen.getByLabelText('Work email'), 'jane@co.com');
    await user.type(screen.getByLabelText('Password'), 'weak');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.type(screen.getByLabelText('Company name'), 'Jane Co');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    expect(await screen.findByText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
  });
});

describe('data pages', () => {
  it('dashboard renders KPI cards from the API', async () => {
    get.mockImplementation(() =>
      ok({
        kpis: { invoicesProcessed: 31, totalInvoices: 31, pendingApproval: 7, approved: 17, rejected: 1, exceptions: 6, automationRate: 41.9, manualReviewRate: 58.1, totalSpend: 376300, potentialDuplicates: 2 },
        charts: { monthly: [{ month: '2026-09', invoices: 5, spend: 1000, automationRate: 40, avgProcessingMs: 120 }], statusBreakdown: [{ status: 'APPROVED', count: 17 }], riskDistribution: [{ risk: 'LOW', count: 20 }], vendorSpend: [{ vendor: 'Acme', spend: 1000 }] },
        onboarding: { aiConfigured: true, rulesReviewed: true, firstInvoice: false },
      }),
    );
    renderPage(<Dashboard />);
    expect(await screen.findByText('Automation rate')).toBeInTheDocument();
    expect(screen.getByText('41.9%')).toBeInTheDocument();
    expect(screen.getByText('Manual review rate 58.1%')).toBeInTheDocument();
    expect(screen.getByText('Potential duplicates')).toBeInTheDocument();
    expect(screen.getByText('Upload your first invoice')).toBeInTheDocument();
  });

  it('dashboard shows an error state with retry', async () => {
    get.mockRejectedValue({ response: { data: { error: { message: 'boom' } } } });
    renderPage(<Dashboard />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('invoice list shows rows, badges and an empty state', async () => {
    get.mockImplementation(() => ok({ items: [{ id: '1', invoiceNumber: 'INV-1', vendor: { name: 'Acme' }, total: 5000, currency: 'INR', status: 'APPROVED', riskLevel: 'LOW', autoApproved: true, duplicateDetected: true, tags: ['High Value'] }], meta: { page: 1, totalPages: 1, total: 1 } }));
    const { unmount } = renderPage(<Invoices />);
    expect(await screen.findByText('INV-1')).toBeInTheDocument();
    expect(screen.getByText('Duplicate')).toBeInTheDocument();
    expect(screen.getByText('High Value')).toBeInTheDocument();
    unmount();
    get.mockImplementation(() => ok({ items: [], meta: { page: 1, totalPages: 1, total: 0 } }));
    renderPage(<Invoices />);
    expect(await screen.findByText('No invoices found')).toBeInTheDocument();
  });

  it('rules list shows summary, status switch and asks for confirmation before delete', async () => {
    const user = userEvent.setup();
    get.mockImplementation((url: string) =>
      url === '/automation/metadata'
        ? ok({ triggers: [] })
        : ok({ items: [{ id: 'r1', name: 'High Value Approval', description: 'd', priority: 3, version: 2, enabled: true, trigger: 'INVOICE_PROCESSED', triggerLabel: 'Invoice processed', conditionsSummary: 'Invoice total is greater than or equal to 50000', actionsSummary: ['Require finance manager approval'], executionCount: 128, lastExecutionAt: null, createdByName: 'Rahul' }], meta: { page: 1, totalPages: 1, total: 1 } }),
    );
    renderPage(<RulesPage />);
    expect(await screen.findByText('High Value Approval')).toBeInTheDocument();
    expect(screen.getByText('Invoice total is greater than or equal to 50000')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable High Value Approval' })).toBeChecked();
    expect(screen.getByText('128')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete High Value Approval' }));
    expect(screen.getByText('Delete rule?')).toBeInTheDocument();
  });
});

describe('RuleTrace', () => {
  it('renders matched and unmatched conditions with actual values', () => {
    renderPage(
      <RuleTrace
        node={{
          type: 'group',
          operator: 'AND',
          matched: false,
          children: [
            { type: 'condition', field: 'invoice.total', label: 'Invoice total', operator: 'greater_than', expected: 50000, actual: 75000, matched: true },
            { type: 'condition', field: 'invoice.purchaseOrderPresent', label: 'Purchase order present', operator: 'equals', expected: true, actual: false, matched: false },
          ],
        }}
      />,
    );
    expect(screen.getByText('Invoice total')).toBeInTheDocument();
    expect(screen.getByText('75000')).toBeInTheDocument();
    expect(screen.getByText('Purchase order present')).toBeInTheDocument();
    expect(screen.getByText(/AND → false/)).toBeInTheDocument();
  });
});
