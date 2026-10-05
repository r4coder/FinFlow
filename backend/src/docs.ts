/** Minimal OpenAPI 3 document generated from a route table, served at /api/docs. */
type Row = [method: string, path: string, summary: string, tag: string, auth?: boolean];

const ROUTES: Row[] = [
  ['post', '/auth/register', 'Register a company workspace and its owner', 'Auth', false],
  ['post', '/auth/login', 'Log in', 'Auth', false],
  ['post', '/auth/refresh', 'Rotate refresh token (httpOnly cookie) and get a new access token', 'Auth', false],
  ['post', '/auth/logout', 'Log out', 'Auth', false],
  ['get', '/auth/me', 'Current user, role, permissions', 'Auth'],
  ['post', '/auth/forgot-password', 'Request a password reset', 'Auth', false],
  ['post', '/auth/reset-password', 'Reset password with token', 'Auth', false],
  ['get', '/invoices', 'List invoices (search, filter, sort, paginate)', 'Invoices'],
  ['post', '/invoices/upload', 'Upload an invoice (PDF/PNG/JPG) as multipart field "file"', 'Invoices'],
  ['post', '/invoices/manual', 'Create an invoice manually', 'Invoices'],
  ['get', '/invoices/export.csv', 'Export invoices as CSV', 'Invoices'],
  ['get', '/invoices/{id}', 'Invoice detail with validation, rules, approvals and audit timeline', 'Invoices'],
  ['patch', '/invoices/{id}', 'Edit extracted fields (exception queue)', 'Invoices'],
  ['post', '/invoices/{id}/reprocess', 'Re-run processing (optionally re-extract with AI)', 'Invoices'],
  ['get', '/invoices/{id}/file', 'Download the stored document (authorized)', 'Invoices'],
  ['get', '/vendors', 'List vendors', 'Vendors'],
  ['post', '/vendors', 'Create vendor', 'Vendors'],
  ['get', '/vendors/{id}', 'Vendor detail', 'Vendors'],
  ['patch', '/vendors/{id}', 'Update vendor', 'Vendors'],
  ['get', '/approvals', 'List approvals', 'Approvals'],
  ['post', '/approvals/{id}/approve', 'Approve', 'Approvals'],
  ['post', '/approvals/{id}/reject', 'Reject (reason required)', 'Approvals'],
  ['post', '/approvals/{id}/request-changes', 'Request changes', 'Approvals'],
  ['get', '/exceptions', 'Exception queue', 'Exceptions'],
  ['post', '/exceptions/{id}/resolve', 'Resolve an exception: APPROVE | REJECT | SEND_FOR_APPROVAL', 'Exceptions'],
  ['get', '/automation/metadata', 'Rule builder metadata (fields, operators, triggers, actions)', 'Automation'],
  ['get', '/automation/rules', 'List rules', 'Automation'],
  ['post', '/automation/rules', 'Create rule', 'Automation'],
  ['get', '/automation/rules/{id}', 'Get rule', 'Automation'],
  ['patch', '/automation/rules/{id}', 'Update rule (creates a new version)', 'Automation'],
  ['delete', '/automation/rules/{id}', 'Soft-delete rule', 'Automation'],
  ['post', '/automation/rules/{id}/duplicate', 'Duplicate rule (copy starts disabled)', 'Automation'],
  ['get', '/automation/rules/{id}/versions', 'Rule version history', 'Automation'],
  ['post', '/automation/rules/{id}/test', 'Dry-run a saved rule against an invoice (no side effects)', 'Automation'],
  ['post', '/automation/rules/test-draft', 'Dry-run an unsaved rule definition', 'Automation'],
  ['get', '/automation/templates', 'Rule templates', 'Automation'],
  ['get', '/automation/executions', 'Rule execution history', 'Automation'],
  ['get', '/automation/executions/{id}', 'Execution detail', 'Automation'],
  ['get', '/analytics/dashboard', 'Dashboard KPIs and charts', 'Analytics'],
  ['get', '/analytics/automation', 'Automation performance', 'Analytics'],
  ['get', '/audit-logs', 'Audit log', 'Audit'],
  ['get', '/notifications', 'My notifications', 'Notifications'],
  ['post', '/notifications/read-all', 'Mark all read', 'Notifications'],
  ['get', '/settings/ai', 'AI settings (key is masked, never returned)', 'Settings'],
  ['post', '/settings/ai/validate', 'Validate a Gemini API key', 'Settings'],
  ['put', '/settings/ai', 'Save AI mode / key', 'Settings'],
  ['delete', '/settings/ai', 'Delete stored key and switch to mock mode', 'Settings'],
  ['get', '/users', 'List users', 'Users'],
  ['post', '/users', 'Create user', 'Users'],
  ['patch', '/users/{id}/role', 'Change role', 'Users'],
  ['delete', '/users/{id}', 'Remove user', 'Users'],
  ['get', '/health', 'Health check', 'System', false],
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, summary, tag, needsAuth = true] of ROUTES) {
    paths[path] ??= {};
    paths[path][method] = {
      summary,
      tags: [tag],
      ...(needsAuth ? { security: [{ bearerAuth: [] }] } : {}),
      ...(path.includes('{id}') ? { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }] } : {}),
      responses: {
        '200': { description: 'Success: { success: true, data }' },
        '400': { description: 'Validation error: { success: false, error: { code, message } }' },
        '401': { description: 'Unauthenticated' },
        '403': { description: 'Forbidden (RBAC)' },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'InvoiceFlow AI API', version: '1.0.0', description: 'AI-Powered Invoice Processing & Business Automation Platform. All endpoints are tenant-scoped by the authenticated user.' },
    servers: [{ url: '/api' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
