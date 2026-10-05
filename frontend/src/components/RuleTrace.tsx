import { Check, X } from 'lucide-react';
import { cn } from '../lib/utils';

/** Renders an evaluated condition tree (as stored by the engine / returned from dry-run). */
export function RuleTrace({ node, depth = 0 }: { node: any; depth?: number }) {
  if (!node || !node.type) return <p className="text-xs text-slate-400">No evaluation data</p>;
  if (node.type === 'condition') {
    return (
      <div className={cn('flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs', node.matched ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300')}>
        {node.matched ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        <span className="font-medium">{node.label ?? node.field}</span>
        <span>{String(node.operator).replace(/_/g, ' ')}</span>
        <code className="rounded bg-white/60 px-1 dark:bg-black/30">{String(node.expected)}</code>
        <span className="text-slate-500">(actual: <code>{node.actual === null || node.actual === undefined ? 'n/a' : String(node.actual)}</code>)</span>
      </div>
    );
  }
  return (
    <div className={cn('space-y-1 rounded-md border border-dashed p-2', node.matched ? 'border-emerald-300' : 'border-slate-300 dark:border-slate-600')} style={{ marginLeft: depth ? 8 : 0 }}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{node.operator} → {node.matched ? 'true' : 'false'}</p>
      {node.children.map((c: any, i: number) => <RuleTrace key={i} node={c} depth={depth + 1} />)}
    </div>
  );
}
