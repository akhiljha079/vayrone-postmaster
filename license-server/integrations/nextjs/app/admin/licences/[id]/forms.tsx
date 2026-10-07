'use client';
import { useActionState, useState, type ReactNode } from 'react';
import type { ActionState } from '../actions';

/** A small form bound to one server action, showing its result inline. */
export function ActionForm({
  title,
  action,
  submit,
  children,
  danger,
  compact,
}: {
  title?: string;
  action: (prev: ActionState, f: FormData) => Promise<ActionState>;
  submit: string;
  children?: ReactNode;
  danger?: boolean;
  compact?: boolean;
}) {
  const [state, run, pending] = useActionState<ActionState, FormData>(action, {});
  return (
    <form action={run} className={compact ? 'space-y-1' : 'space-y-3 rounded-lg border border-slate-200 p-4'}>
      {title && <h2 className="font-semibold">{title}</h2>}
      {children}
      {state.error && <p className="rounded bg-red-50 px-2 py-1 text-sm text-red-800">{state.error}</p>}
      {state.ok && <p className="rounded bg-emerald-50 px-2 py-1 text-sm text-emerald-800">{state.ok}</p>}
      <button
        disabled={pending}
        className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${danger ? 'bg-red-600 text-white hover:bg-red-700' : compact ? 'border border-slate-300 hover:bg-slate-50' : 'bg-blue-700 text-white hover:bg-blue-800'}`}
      >
        {pending ? 'Working…' : submit}
      </button>
    </form>
  );
}

/** The licence key, selectable, with a copy button. */
export function CopyKey({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2">
      <code className="select-all font-mono text-sm">{value}</code>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false))}
        className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
