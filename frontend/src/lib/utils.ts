export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function money(v: number | null | undefined, currency: string | null | undefined = 'INR') {
  if (v === null || v === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency ?? ''} ${v}`;
  }
}
export const dateStr = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const pretty = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

export const STATUS_STYLE: Record<string, string> = {
  APPROVED: 'green', PAID: 'green', SUCCESS: 'green', COMPLETED: 'green', LOW: 'green',
  PENDING_APPROVAL: 'amber', PENDING: 'amber', MEDIUM: 'amber', WAITING: 'slate', PROCESSING: 'blue', EXTRACTED: 'blue', VALIDATING: 'blue', UPLOADED: 'slate', QUEUED: 'slate', RUNNING: 'blue',
  MANUAL_REVIEW: 'orange', HIGH: 'orange', PARTIAL_FAILURE: 'orange', CHANGES_REQUESTED: 'orange', SUPPRESSED: 'slate', SKIPPED: 'slate', NOT_MATCHED: 'slate', CANCELLED: 'slate',
  REJECTED: 'red', FAILED: 'red', CRITICAL: 'red',
};
