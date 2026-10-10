import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ApiError } from '../api';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- buttons
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary: 'bg-white text-slate-700 shadow-sm ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
};

export function Button({ variant = 'primary', busy, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || busy}
      className={cx('inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed sm:min-h-8', VARIANT[variant], className)}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- inputs
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputBase = 'block min-h-10 rounded-md border-0 bg-white px-2.5 py-1.5 text-sm shadow-sm sm:min-h-9 text-slate-900 ring-1 ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';
/** Full width unless the caller sets a width (cx does not resolve conflicting Tailwind classes). */
const inputCls = (extra?: string) => cx(inputBase, /(^|\s)w-/.test(extra ?? '') ? '' : 'w-full', extra);

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={inputCls(p.className)} />;
}

export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={inputCls(cx('font-mono', p.className))} />;
}

export function Select({ children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={inputCls(cx('pr-8', p.className))}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-center gap-2 text-sm', disabled ? 'text-slate-400' : 'text-slate-700')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- layout
export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('min-w-0 rounded-xl bg-white shadow-sm ring-1 ring-slate-200/80', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  blue: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};
export function Badge({ color = 'slate', children }: { color?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE[color])}>{children}</span>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{msg}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-slate-500">{children}</div>;
}

export function Spinner() {
  return (
    <div className="flex justify-center py-10">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50/80">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 [&>tr:hover]:bg-slate-50/60">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...p} className={cx('px-3 py-2.5 align-top', className)} />;

// ---------------------------------------------------------------- modal
export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Parents pass a new onClose on every render (pages refresh every few seconds): keep it in a ref,
  // so focus moves to the first field only when the dialog opens, never while someone is typing.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 backdrop-blur-[1px] sm:items-start sm:overflow-y-auto sm:p-10" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-h-none sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <button onClick={() => close.current()} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:overflow-visible sm:px-5">{children}</div>
        {footer && (
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-xl sm:px-5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** Promise-based confirm dialog. */
export function useConfirm(): [(msg: string, opts?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>, ReactNode] {
  const [s, setS] = useState<{ msg: string; danger: boolean; label: string; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback(
    (msg: string, opts: { danger?: boolean; confirmLabel?: string } = {}) =>
      new Promise<boolean>((resolve) => setS({ msg, danger: opts.danger ?? true, label: opts.confirmLabel ?? 'Confirm', resolve })),
    [],
  );
  const close = (v: boolean) => {
    s?.resolve(v);
    setS(null);
  };
  const node = (
    <Modal
      open={!!s}
      title="Please confirm"
      onClose={() => close(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant={s?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {s?.label}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">{s?.msg}</p>
    </Modal>
  );
  return [ask, node];
}

// ---------------------------------------------------------------- data hook
export function useResource<T>(loader: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    loader().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

/** Runs an async action, tracking busy/error state for forms. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>): { run: (...a: A) => Promise<boolean>; busy: boolean; error: unknown; setError: (e: unknown) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...a: A) => {
    setBusy(true);
    setError(null);
    try {
      await fn(...a);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, setError };
}

export function generatePassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#@%+';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let p = Array.from(buf, (x) => chars[x % chars.length]).join('');
  if (!/\d/.test(p)) p = p.slice(0, -1) + '7';
  return p;
}
