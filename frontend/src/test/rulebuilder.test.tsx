import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import metadata from './fixtures/metadata.json';
import { ok, renderPage } from './utils';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<any>('../lib/api');
  return { ...actual, api: { get: (...a: any[]) => get(...a), post: (...a: any[]) => post(...a), patch: (...a: any[]) => patch(...a), delete: vi.fn() } };
});
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => true, me: { id: 'u1', fullName: 'Test', role: 'OWNER', permissions: [], organization: { name: 'Co' } } }) }));

import RuleBuilder from '../pages/RuleBuilder';

const INVOICES = { items: [{ id: 'inv-1', invoiceNumber: 'INV-1042', fileName: 'x.pdf', vendor: { name: 'Acme' }, total: 92000, currency: 'INR' }] };

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  get.mockImplementation((url: string) => {
    if (url === '/automation/metadata') return ok(metadata);
    if (url === '/users') return ok([{ id: 'u1', fullName: 'Rahul', email: 'r@x.com' }, { id: 'u2', fullName: 'Priya', email: 'p@x.com' }]);
    if (url === '/vendors') return ok({ items: [{ id: 'v1', name: 'Acme' }] });
    if (url === '/invoices') return ok(INVOICES);
    if (url === '/automation/templates')
      return ok([
        {
          key: 't1',
          name: 'High Value',
          description: 'd',
          trigger: 'INVOICE_PROCESSED',
          priority: 3,
          conditions: { operator: 'AND', conditions: [{ field: 'invoice.total', operator: 'greater_than', value: 75000 }, { field: 'invoice.riskLevel', operator: 'not_equals', value: 'LOW' }] },
          actions: [{ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' }, { type: 'ADD_TAG', tag: 'High Risk' }],
        },
      ]);
    return ok({});
  });
});

const page = (route = '/automation/rules/new') =>
  renderPage(
    <Routes>
      <Route path="/automation/rules/new" element={<RuleBuilder />} />
      <Route path="/automation/rules/:id" element={<div>saved page</div>} />
    </Routes>,
    route,
  );

describe('Rule builder', () => {
  it('shows the WHEN / IF / THEN flow', async () => {
    page();
    expect(await screen.findByText('When')).toBeInTheDocument();
    expect(screen.getByText('If')).toBeInTheDocument();
    expect(screen.getByText('Then')).toBeInTheDocument();
    expect(screen.getByLabelText('Trigger')).toHaveValue('INVOICE_PROCESSED');
  });

  it('builds a rule with AND/OR groups and posts the exact structure the backend expects', async () => {
    const user = userEvent.setup();
    post.mockImplementation((url: string) => (url === '/automation/rules' ? ok({ id: 'new-1' }) : ok({})));
    page();
    await screen.findByText('When');
    await user.type(screen.getByPlaceholderText('High Value Invoice Approval'), 'Risky big invoices');

    const value = screen.getByLabelText('Value');
    await user.clear(value);
    await user.type(value, '75000');

    await user.click(screen.getAllByRole('button', { name: /Condition/ }).find((b) => b.textContent?.trim() === 'Condition')!);
    const fields = screen.getAllByLabelText('Field');
    await user.selectOptions(fields[1], 'invoice.riskLevel');
    await user.selectOptions(screen.getAllByLabelText('Operator')[1], 'not_equals');
    await user.selectOptions(screen.getAllByLabelText('Value')[1], 'LOW');

    await user.click(screen.getByRole('button', { name: /ANY \(OR\)/ }));
    expect(screen.getAllByText('OR').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /ALL \(AND\)/ }));

    await user.click(screen.getByRole('button', { name: /Group/ }));
    expect(screen.getAllByLabelText('Field')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /Add action/ }));
    await user.selectOptions(screen.getAllByLabelText('Action')[1], 'SEND_NOTIFICATION');

    await user.click(screen.getByRole('button', { name: /Save rule/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/automation/rules', expect.anything()));
    const body = post.mock.calls.find((c) => c[0] === '/automation/rules')![1];
    expect(body).toMatchObject({ name: 'Risky big invoices', trigger: 'INVOICE_PROCESSED', priority: 50, enabled: true });
    expect(body.conditions.operator).toBe('AND');
    expect(body.conditions.conditions[0]).toEqual({ field: 'invoice.total', operator: 'greater_than', value: 75000 });
    expect(body.conditions.conditions[1]).toEqual({ field: 'invoice.riskLevel', operator: 'not_equals', value: 'LOW' });
    expect(body.conditions.conditions[2]).toMatchObject({ operator: 'AND', conditions: [{ field: 'invoice.total' }] });
    expect(body.actions[0]).toEqual({ type: 'REQUIRE_APPROVAL', role: 'FINANCE_MANAGER' });
    expect(body.actions[1]).toMatchObject({ type: 'SEND_NOTIFICATION', recipient: 'FINANCE_MANAGER' });
    expect(await screen.findByText('saved page')).toBeInTheDocument();
  });

  it('pre-fills from a template', async () => {
    page('/automation/rules/new?template=t1');
    expect(await screen.findByDisplayValue('High Value')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Field')).toHaveLength(2);
    expect(screen.getByDisplayValue('High Risk')).toBeInTheDocument();
  });

  it('only offers side-effect actions on triggers that run after a decision', async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText('When');
    await user.selectOptions(screen.getByLabelText('Trigger'), 'INVOICE_APPROVED');
    expect(screen.queryAllByLabelText('Action')).toHaveLength(0); // default decision action was dropped
    await user.click(screen.getByRole('button', { name: /Add action/ }));
    const select = screen.getByLabelText('Action');
    expect(within(select).queryByRole('option', { name: 'Auto-approve invoice' })).toBeNull();
    expect(within(select).getByRole('option', { name: 'Send notification' })).toBeInTheDocument();
  });

  it('runs the dry-run tester and shows per-condition results without saving', async () => {
    const user = userEvent.setup();
    post.mockImplementation((url: string) =>
      url === '/automation/rules/test-draft'
        ? ok({
            dryRun: true,
            matched: true,
            invoice: { invoiceNumber: 'INV-1042', total: 92000, currency: 'INR', riskLevel: 'HIGH' },
            trace: { type: 'group', operator: 'AND', matched: true, children: [{ type: 'condition', field: 'invoice.total', label: 'Invoice total', operator: 'greater_than', expected: 75000, actual: 92000, matched: true }] },
            actionDetails: [{ description: 'Require finance manager approval' }, { description: 'Add tag "High Risk"' }],
            decisionPreview: { disposition: 'REQUIRE_APPROVAL', decidedBy: 'Risky' },
            note: 'Dry run only — no actions were executed and nothing was changed.',
          })
        : ok({}),
    );
    page();
    await screen.findByText('When');
    await user.selectOptions(screen.getByLabelText('Invoice to test against'), 'inv-1');
    await user.click(screen.getByRole('button', { name: 'Test rule' }));
    expect(await screen.findByText('MATCH')).toBeInTheDocument();
    expect(screen.getByText('Require finance manager approval')).toBeInTheDocument();
    expect(screen.getByText(/nothing was changed/i)).toBeInTheDocument();
    expect(post.mock.calls.every((c) => c[0] === '/automation/rules/test-draft')).toBe(true);
  });

  it('surfaces backend validation errors', async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({ response: { data: { error: { message: 'Action 1 (REQUIRE_APPROVAL): Choose a role or a specific user' } } } });
    page();
    await screen.findByText('When');
    await user.click(screen.getByRole('button', { name: /Save rule/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a role or a specific user');
  });
});
