import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, formatBytes, get, post } from '../../api';
import { Button, ErrorBanner, Select } from '../../components/ui';
import { addrText, type Addr, type FullMessage } from './types';

export interface ComposeInit {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string | null;
  replyToItemId?: number;
  forwardOfItemId?: number;
  draftItemId?: number;
  carried?: { itemId: number; index: number; filename: string; size: number }[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Quoted original for reply/forward. <style> blocks are removed so they cannot restyle the app. */
function quoteHtml(m: FullMessage): string {
  return m.html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<img[^>]*data-vpm-src[^>]*>/gi, '');
}

const prefix = (p: string, s: string) => (new RegExp(`^${p}:`, 'i').test(s) ? s : `${p}: ${s}`);

export function replyInit(m: FullMessage, me: string[], all: boolean): ComposeInit {
  const sender = (m.replyTo.length ? m.replyTo : m.from).map(addrText);
  const others = all ? m.to.filter((a) => !me.includes(a.address)).map(addrText) : [];
  const cc = all ? m.cc.filter((a) => !me.includes(a.address)).map(addrText) : [];
  const when = new Date(m.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  return {
    to: [...sender, ...others],
    cc,
    subject: prefix('Re', m.subject),
    html: `<p><br></p><p><br></p><div style="color:#475569">On ${esc(when)}, ${esc(m.from.map(addrText).join(', '))} wrote:</div><blockquote style="border-left:3px solid #cbd5e1;margin:0;padding-left:12px">${quoteHtml(m)}</blockquote>`,
    inReplyTo: m.messageId,
    references: [m.references, m.messageId].filter(Boolean).join(' ') || null,
    replyToItemId: m.id,
  };
}

export function forwardInit(m: FullMessage): ComposeInit {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${esc(m.from.map(addrText).join(', '))}`,
    `Date: ${esc(new Date(m.date).toLocaleString('en-IN'))}`,
    `Subject: ${esc(m.subject)}`,
    `To: ${esc(m.to.map(addrText).join(', '))}`,
  ].join('<br>');
  return {
    subject: prefix('Fwd', m.subject),
    html: `<p><br></p><p><br></p><div style="color:#475569">${header}</div><br>${quoteHtml(m)}`,
    forwardOfItemId: m.id,
    carried: m.attachments.map((a) => ({ itemId: m.id, index: a.index, filename: a.filename, size: a.size })),
  };
}

export function draftInit(m: FullMessage): ComposeInit {
  return {
    to: m.to.map(addrText),
    cc: m.cc.map(addrText),
    bcc: m.bcc.map(addrText),
    subject: m.subject,
    html: quoteHtml(m),
    inReplyTo: m.inReplyTo,
    references: m.references,
    draftItemId: m.id,
    carried: m.attachments.map((a) => ({ itemId: m.id, index: a.index, filename: a.filename, size: a.size })),
  };
}

// ---------------------------------------------------------------- recipients

function RecipientInput({ label, value, onChange, autoFocus }: { label: string; value: string[]; onChange: (v: string[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [suggest, setSuggest] = useState<Addr[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return setSuggest([]);
    const t = setTimeout(() => get<Addr[]>(`/api/mail/contacts?q=${encodeURIComponent(q)}`).then(setSuggest, () => setSuggest([])), 150);
    return () => clearTimeout(t);
  }, [text]);
  const add = (s: string) => {
    const parts = s
      .split(/[,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText('');
    setSuggest([]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggest.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : suggest.length - 1)) % suggest.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && suggest.length && text) {
      e.preventDefault();
      add(addrText(suggest[active]!));
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (text.trim()) {
        e.preventDefault();
        add(text);
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="relative flex items-start gap-2 border-b border-slate-100 px-3 py-1.5">
      <span className="w-10 pt-1 text-sm text-slate-500">{label}</span>
      <div className="flex flex-1 flex-wrap items-center gap-1">
        {value.map((v) => (
          <span key={v} className="flex items-center gap-1 rounded bg-brand-50 px-2 py-0.5 text-sm text-brand-900">
            {v}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="text-brand-700 hover:text-red-600" aria-label={`Remove ${v}`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-[10rem] flex-1 border-0 p-1 text-sm focus:outline-none"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => (setText(e.target.value), setActive(0))}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => text.trim() && add(text), 150)}
          aria-label={label}
        />
      </div>
      {suggest.length > 0 && (
        <ul className="absolute left-14 top-full z-20 mt-1 w-80 rounded-md bg-white py-1 text-sm shadow-lg ring-1 ring-slate-200">
          {suggest.map((s, i) => (
            <li key={s.address}>
              <button type="button" onMouseDown={() => add(addrText(s))} className={`block w-full px-3 py-1.5 text-left ${i === active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                <div className="font-medium">{s.name || s.address}</div>
                {s.name && <div className="text-xs text-slate-500">{s.address}</div>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor

const TOOLS: [string, string, string?][] = [
  ['bold', 'B'],
  ['italic', 'I'],
  ['underline', 'U'],
  ['insertUnorderedList', '•'],
  ['insertOrderedList', '1.'],
  ['createLink', '🔗'],
  ['removeFormat', '⌫'],
];

function Editor({ initial, onChange }: { initial: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.innerHTML = initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = (cmd: string) => {
    ref.current?.focus();
    if (cmd === 'createLink') {
      const url = window.prompt('Link address (https://…)');
      if (url && /^(https?:|mailto:)/i.test(url)) document.execCommand('createLink', false, url);
    } else document.execCommand(cmd);
    onChange(ref.current?.innerHTML ?? '');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-slate-100 px-2 py-1">
        {TOOLS.map(([cmd, label]) => (
          <button key={cmd} type="button" onMouseDown={(e) => (e.preventDefault(), run(cmd))} className="rounded px-2 py-0.5 text-sm text-slate-600 hover:bg-slate-100" title={cmd}>
            {label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
        className="min-h-[14rem] flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed focus:outline-none [&_blockquote]:border-l-2 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
      />
    </div>
  );
}

// ---------------------------------------------------------------- composer

interface Upload {
  id: string;
  filename: string;
  size: number;
}

export function Compose({ init, identities, onClose, onSent }: { init: ComposeInit; identities: { displayName: string; addresses: string[] }; onClose: () => void; onSent: (msg: string) => void }) {
  const [from, setFrom] = useState(identities.addresses[0] ?? '');
  const [to, setTo] = useState(init.to ?? []);
  const [cc, setCc] = useState(init.cc ?? []);
  const [bcc, setBcc] = useState(init.bcc ?? []);
  const [showCc, setShowCc] = useState(Boolean(init.cc?.length || init.bcc?.length));
  const [subject, setSubject] = useState(init.subject ?? '');
  const [html, setHtml] = useState(init.html ?? '');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [carried, setCarried] = useState(init.carried ?? []);
  const [draftId, setDraftId] = useState<number | undefined>(init.draftItemId);
  const [busy, setBusy] = useState<'send' | 'draft' | 'upload' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const dirty = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dirty.current = true;
  }, [to, cc, bcc, subject, html, uploads, carried]);

  const payload = () => ({
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    uploads: uploads.map((u) => u.id),
    carried: carried.map((c) => ({ itemId: c.itemId, index: c.index })),
    replyToItemId: init.replyToItemId ?? null,
    forwardOfItemId: init.forwardOfItemId ?? null,
    inReplyTo: init.inReplyTo ?? null,
    references: init.references ?? null,
    draftItemId: draftId ?? null,
  });

  const saveDraft = async (quiet = false) => {
    if (!quiet) setBusy('draft');
    try {
      const r = await post<{ draftItemId: number }>('/api/mail/drafts', payload());
      // The draft now holds the attachments; later edits carry them from the draft.
      // Attachment order in the saved draft: carried ones first, then uploads.
      setCarried([
        ...carried.map((c, i) => ({ ...c, itemId: r.draftItemId, index: i })),
        ...uploads.map((u, i) => ({ itemId: r.draftItemId, index: carried.length + i, filename: u.filename, size: u.size })),
      ]);
      setUploads([]);
      setDraftId(r.draftItemId);
      setSavedAt(new Date());
      dirty.current = false;
    } catch (e) {
      if (!quiet) setError(e);
    } finally {
      if (!quiet) setBusy(null);
    }
  };

  // Autosave every 30 s while there are unsaved changes.
  useEffect(() => {
    const t = setInterval(() => {
      if (dirty.current && busy === null && (subject || html.replace(/<[^>]+>/g, '').trim() || to.length)) void saveDraft(true);
    }, 30_000);
    return () => clearInterval(t);
  });

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      await post('/api/mail/send', payload());
      onSent(`Message sent${to.length ? ` to ${to[0]}${to.length > 1 ? ` and ${to.length - 1} more` : ''}` : ''}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('upload');
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', f, f.name);
        const csrf = document.cookie.split('; ').find((c) => c.startsWith('vpm_csrf='))?.slice(9) ?? '';
        const res = await fetch('/api/mail/uploads', { method: 'POST', body: fd, headers: { 'x-vpm-csrf': csrf }, credentials: 'same-origin' });
        const data = (await res.json()) as Upload & { message?: string; error?: string };
        if (!res.ok) throw new ApiError(res.status, data.error ?? 'UPLOAD', data.message ?? 'Upload failed');
        setUploads((u) => [...u, data]);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const close = async () => {
    if (dirty.current && (subject || to.length || html.replace(/<[^>]+>/g, '').trim())) await saveDraft(true);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/30 sm:items-center sm:p-6"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
        if (e.key === 'Escape') void close();
      }}
    >
      <div className="flex h-full w-full max-w-4xl flex-col overflow-hidden bg-white shadow-2xl sm:h-[85vh] sm:rounded-lg" role="dialog" aria-label="New message">
        <header className="flex items-center justify-between bg-brand-900 px-4 py-2 text-white">
          <span className="font-medium">{subject || 'New message'}</span>
          <button onClick={() => void close()} className="rounded px-2 hover:bg-white/10" aria-label="Close">
            ✕
          </button>
        </header>
        <ErrorBanner error={error} />
        {identities.addresses.length > 1 && (
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
            <span className="w-10 text-sm text-slate-500">From</span>
            <Select className="w-auto py-0.5" value={from} onChange={(e) => setFrom(e.target.value)}>
              {identities.addresses.map((a) => (
                <option key={a} value={a}>
                  {identities.displayName} &lt;{a}&gt;
                </option>
              ))}
            </Select>
          </div>
        )}
        <RecipientInput label="To" value={to} onChange={setTo} autoFocus={!to.length} />
        {showCc ? (
          <>
            <RecipientInput label="Cc" value={cc} onChange={setCc} />
            <RecipientInput label="Bcc" value={bcc} onChange={setBcc} />
          </>
        ) : (
          <button type="button" onClick={() => setShowCc(true)} className="border-b border-slate-100 px-3 py-1 text-left text-xs text-brand-700 hover:underline">
            Add Cc / Bcc
          </button>
        )}
        <input
          className="border-b border-slate-100 px-3 py-2 text-sm focus:outline-none"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          aria-label="Subject"
        />
        <Editor initial={init.html ?? ''} onChange={setHtml} />
        {(uploads.length > 0 || carried.length > 0) && (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 px-3 py-2">
            {[...carried.map((c) => ({ key: `c${c.itemId}-${c.index}`, name: c.filename, size: c.size, remove: () => setCarried(carried.filter((x) => x !== c)) })), ...uploads.map((u) => ({ key: u.id, name: u.filename, size: u.size, remove: () => setUploads(uploads.filter((x) => x !== u)) }))].map((a) => (
              <span key={a.key} className="flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs">
                📎 {a.name} <span className="text-slate-500">{formatBytes(a.size)}</span>
                <button type="button" onClick={a.remove} className="text-slate-500 hover:text-red-600" aria-label={`Remove ${a.name}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <footer className="flex items-center gap-2 border-t border-slate-200 px-3 py-2">
          <Button busy={busy === 'send'} onClick={() => void send()} title="Ctrl+Enter">
            Send
          </Button>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
          <Button variant="secondary" busy={busy === 'upload'} onClick={() => fileRef.current?.click()}>
            Attach
          </Button>
          <Button variant="ghost" busy={busy === 'draft'} onClick={() => void saveDraft()}>
            Save draft
          </Button>
          {savedAt && <span className="text-xs text-slate-500">Draft saved {savedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
          <Button
            variant="ghost"
            className="ml-auto text-red-600"
            onClick={() => {
              // Remove a draft autosaved during this session (never one the user opened to edit).
              if (draftId && draftId !== init.draftItemId) void post('/api/mail/messages/actions', { ids: [draftId], action: 'delete' });
              onClose();
            }}
          >
            Discard
          </Button>
        </footer>
      </div>
    </div>
  );
}
