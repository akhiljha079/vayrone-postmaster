import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { del, formatBytes, get, patch, post } from '../../api';
import { useAuth } from '../../auth';
import { Button, ErrorBanner, Input, Spinner, useConfirm } from '../../components/ui';
import { Compose, draftInit, forwardInit, replyInit, type ComposeInit } from './Compose';
import { Reader, type ReaderAction } from './Reader';
import { FOLDER_ICON, displayName, folderName, shortDate, useMailSocket, type Folder, type ListItem } from './types';

interface FolderResp {
  folders: Folder[];
  quota: { used: number; limit: number | null };
}
interface ListResp {
  items: ListItem[];
  nextBefore: number | null;
}

function FolderPane({
  data,
  current,
  onSelect,
  onCompose,
  onChanged,
  live,
}: {
  data: FolderResp | null;
  current: number | null;
  onSelect: (id: number) => void;
  onCompose: () => void;
  onChanged: () => void;
  live: boolean;
}) {
  const [ask, confirmNode] = useConfirm();
  const newFolder = async () => {
    const name = window.prompt('Folder name (use / for a subfolder, e.g. Clients/Sharma)');
    if (name?.trim()) {
      await post('/api/mail/folders', { path: name.trim() });
      onChanged();
    }
  };
  const quota = data?.quota;
  const pct = quota?.limit ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0;
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
      {confirmNode}
      <div className="p-3">
        <Button className="w-full" onClick={onCompose} title="Compose (c)">
          ✎ New message
        </Button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2" aria-label="Folders">
        {(data?.folders ?? []).map((f) => (
          <div key={f.id} className="group flex items-center">
            <button
              onClick={() => onSelect(f.id)}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${current === f.id ? 'bg-brand-50 font-medium text-brand-900' : 'text-slate-700 hover:bg-slate-50'}`}
            >
              <span aria-hidden className="w-4 text-center">
                {FOLDER_ICON[f.specialUse ?? ''] ?? '📁'}
              </span>
              <span className="truncate" style={{ paddingLeft: f.specialUse ? 0 : (f.path.split('/').length - 1) * 10 }}>
                {f.specialUse ? folderName(f) : f.path.split('/').pop()}
              </span>
              {f.unseen > 0 && f.specialUse !== 'sent' && f.specialUse !== 'trash' && <span className="ml-auto text-xs font-semibold tabular text-brand-700">{f.unseen}</span>}
              {f.specialUse === 'drafts' && f.messages > 0 && <span className="ml-auto text-xs tabular text-slate-500">{f.messages}</span>}
            </button>
            {!f.specialUse && (
              <span className="hidden gap-0.5 group-hover:flex">
                <button
                  className="rounded px-1 text-xs text-slate-400 hover:text-slate-700"
                  title="Rename"
                  onClick={async () => {
                    const name = window.prompt('New name', f.path);
                    if (name && name !== f.path) {
                      await patch(`/api/mail/folders/${f.id}`, { path: name });
                      onChanged();
                    }
                  }}
                >
                  ✎
                </button>
                <button
                  className="rounded px-1 text-xs text-slate-400 hover:text-red-600"
                  title="Delete"
                  onClick={async () => {
                    if (await ask(`Delete folder "${f.path}" and all ${f.messages} messages in it?`, { confirmLabel: 'Delete folder' })) {
                      await del(`/api/mail/folders/${f.id}`);
                      onChanged();
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            )}
          </div>
        ))}
        <button onClick={() => void newFolder()} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-500 hover:bg-slate-50">
          + New folder
        </button>
      </nav>
      <div className="border-t border-slate-100 p-3 text-xs text-slate-500">
        {quota && (
          <>
            <div>
              {formatBytes(quota.used)} {quota.limit ? `of ${formatBytes(quota.limit)}` : 'used'}
            </div>
            {quota.limit && (
              <div className="mt-1 h-1.5 rounded bg-slate-100">
                <div className={`h-1.5 rounded ${pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
              </div>
            )}
          </>
        )}
        <div className="mt-2 flex items-center gap-1.5" title={live ? 'New mail appears instantly' : 'Reconnecting…'}>
          <span className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          {live ? 'Live' : 'Connecting…'}
        </div>
      </div>
    </aside>
  );
}

function Row({ m, active, checked, onOpen, onCheck, sentView }: { m: ListItem; active: boolean; checked: boolean; onOpen: () => void; onCheck: (v: boolean) => void; sentView: boolean }) {
  return (
    <li
      onClick={onOpen}
      className={`flex cursor-pointer gap-2 border-b border-slate-100 px-3 py-2 ${active ? 'bg-brand-50' : checked ? 'bg-slate-50' : 'hover:bg-slate-50'} ${m.seen ? '' : 'border-l-2 border-l-brand-600'}`}
    >
      <input type="checkbox" checked={checked} onClick={(e) => e.stopPropagation()} onChange={(e) => onCheck(e.target.checked)} className="mt-1" aria-label="Select message" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`truncate text-sm ${m.seen ? 'text-slate-700' : 'font-semibold text-slate-900'}`}>
            {m.draft ? <span className="text-red-600">[Draft] </span> : null}
            {sentView ? `To: ${m.to.join(', ')}` : displayName(m.from)}
          </span>
          <span className="ml-auto shrink-0 text-xs tabular text-slate-500">{shortDate(m.date)}</span>
        </div>
        <div className="flex items-center gap-1">
          <span className={`truncate text-sm ${m.seen ? 'text-slate-600' : 'font-medium text-slate-800'}`}>{m.subject || '(no subject)'}</span>
          <span className="ml-auto flex shrink-0 gap-1 text-xs">
            {m.hasAttachments && <span title="Attachment">📎</span>}
            {m.answered && <span title="Replied">↩</span>}
            {m.forwarded && <span title="Forwarded">↪</span>}
            {m.flagged && <span title="Flagged" className="text-amber-500">⚑</span>}
          </span>
        </div>
        <div className="truncate text-xs text-slate-500">{m.preview}</div>
      </div>
    </li>
  );
}

export function Webmail() {
  const { branding } = useAuth();
  const [folders, setFolders] = useState<FolderResp | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [items, setItems] = useState<ListItem[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'flagged'>('all');
  const [everywhere, setEverywhere] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const [identities, setIdentities] = useState<{ displayName: string; addresses: string[] }>({ displayName: '', addresses: [] });
  const [toast, setToast] = useState<string | null>(null);
  const lastInboxUnseen = useRef<number | null>(null);

  const folder = folders?.folders.find((f) => f.id === current) ?? null;
  const inbox = folders?.folders.find((f) => f.specialUse === 'inbox');

  const loadFolders = useCallback(async () => {
    const f = await get<FolderResp>('/api/mail/folders');
    setFolders(f);
    const ib = f.folders.find((x) => x.specialUse === 'inbox');
    if (ib) {
      if (lastInboxUnseen.current !== null && ib.unseen > lastInboxUnseen.current) {
        const n = ib.unseen - lastInboxUnseen.current;
        setToast(`${n} new message${n > 1 ? 's' : ''}`);
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(branding?.company?.name ?? 'Vayrone PostMaster', { body: `${n} new message${n > 1 ? 's' : ''} in your Inbox`, icon: '/favicon.svg' });
        }
      }
      lastInboxUnseen.current = ib.unseen;
      document.title = `${ib.unseen ? `(${ib.unseen}) ` : ''}Inbox — Vayrone PostMaster`;
    }
    setCurrent((c) => c ?? ib?.id ?? f.folders[0]?.id ?? null);
  }, [branding]);

  const params = useMemo(() => `${query ? `&q=${encodeURIComponent(query)}` : ''}${filter === 'unread' ? '&unread=1' : ''}${filter === 'flagged' ? '&flagged=1' : ''}`, [query, filter]);

  /** Reloads the first page; older pages already loaded are kept (live refresh must not jump). */
  const loadList = useCallback(
    async (reset: boolean) => {
      if (!current) return;
      setLoading(true);
      try {
        if (everywhere && query) {
          const r = await get<{ items: (ListItem & { folderPath: string })[] }>(`/api/mail/search?q=${encodeURIComponent(query)}`);
          setItems(r.items.map((i) => ({ ...i, subject: `${i.subject}`, preview: `[${i.folderPath}] ${i.preview}` })));
          setNextBefore(null);
          setError(null);
          return;
        }
        const r = await get<ListResp>(`/api/mail/folders/${current}/messages?limit=50${params}`);
        setItems((old) => {
          if (reset) return r.items;
          const first = new Set(r.items.map((i) => i.id));
          const oldest = r.items.length ? r.items[r.items.length - 1]!.uid : Infinity;
          return [...r.items, ...old.filter((o) => !first.has(o.id) && o.uid < oldest)];
        });
        if (reset) setNextBefore(r.nextBefore);
        setError(null);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [current, params, everywhere, query],
  );

  const loadMore = async () => {
    if (!current || !nextBefore) return;
    const r = await get<ListResp>(`/api/mail/folders/${current}/messages?limit=50&before=${nextBefore}${params}`);
    setItems((old) => [...old, ...r.items]);
    setNextBefore(r.nextBefore);
  };

  useEffect(() => {
    void loadFolders();
    get<{ displayName: string; addresses: string[] }>('/api/mail/identities').then(setIdentities, () => {});
  }, [loadFolders]);
  useEffect(() => {
    setSelected(new Set());
    setOpen(null);
    void loadList(true);
  }, [current, params, loadList]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const live = useMailSocket((changed) => {
    void loadFolders();
    if (current && changed.includes(current)) void loadList(false);
  });

  const act = async (action: string, ids: number[], folderId?: number) => {
    if (!ids.length) return;
    try {
      await post('/api/mail/messages/actions', { ids, action, ...(folderId ? { folderId } : {}) });
      if (['delete', 'move', 'junk', 'not_junk'].includes(action)) {
        setItems((old) => old.filter((m) => !ids.includes(m.id)));
        if (open && ids.includes(open)) setOpen(null);
        setSelected(new Set());
      } else {
        setItems((old) =>
          old.map((m) =>
            ids.includes(m.id)
              ? { ...m, ...(action === 'read' ? { seen: true } : action === 'unread' ? { seen: false } : action === 'flag' ? { flagged: true } : action === 'unflag' ? { flagged: false } : {}) }
              : m,
          ),
        );
      }
      void loadFolders();
    } catch (e) {
      setError(e);
    }
  };

  const onReaderAction = (a: ReaderAction, m: Parameters<typeof replyInit>[0]) => {
    if (a === 'reply' || a === 'replyAll') return setCompose(replyInit(m, identities.addresses, a === 'replyAll'));
    if (a === 'forward') return setCompose(forwardInit(m));
    if (a === 'editDraft') return setCompose(draftInit(m));
    if (typeof a === 'object') return void act('move', [m.id], a.move);
    if (a === 'unread') {
      void act('unread', [m.id]);
      return setOpen(null);
    }
    void act(a, [m.id]);
  };

  // Keyboard shortcuts (outside inputs): c = compose, r = reply, Delete = delete, j/k = next/previous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (compose || t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === 'c') setCompose({});
      if (e.key === 'Delete' && (selected.size || open)) void act('delete', selected.size ? [...selected] : [open!]);
      if (e.key === 'j' || e.key === 'k') {
        const i = items.findIndex((m) => m.id === open);
        const n = items[e.key === 'j' ? i + 1 : Math.max(0, i - 1)];
        if (n) setOpen(n.id);
      }
      if (e.key === 'r' && open) get(`/api/mail/messages/${open}?markRead=0`).then((m) => setCompose(replyInit(m as Parameters<typeof replyInit>[0], identities.addresses, false)), () => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sel = [...selected];
  const isTrash = folder?.specialUse === 'trash' || folder?.specialUse === 'junk';

  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <div className="hidden md:flex">
        <FolderPane data={folders} current={current} onSelect={(id) => (setCurrent(id), setQ(''), setQuery(''))} onCompose={() => setCompose({})} onChanged={() => void loadFolders()} live={live} />
      </div>
      <section className={`flex min-w-0 flex-col border-r border-slate-200 bg-white md:w-[24rem] lg:w-[28rem] ${open ? 'hidden md:flex' : 'flex w-full'}`}>
        <div className="space-y-2 border-b border-slate-200 p-2">
          <div className="flex gap-2 md:hidden">
            <select className="flex-1 rounded-md text-sm ring-1 ring-slate-300" value={current ?? ''} onChange={(e) => setCurrent(Number(e.target.value))} aria-label="Folder">
              {(folders?.folders ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {folderName(f)} {f.unseen ? `(${f.unseen})` : ''}
                </option>
              ))}
            </select>
            <Button onClick={() => setCompose({})}>✎</Button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
            className="flex gap-2"
          >
            <Input placeholder={`Search ${folder ? folderName(folder) : ''}`} value={q} onChange={(e) => setQ(e.target.value)} />
            {query && (
              <Button variant="ghost" onClick={() => (setQ(''), setQuery(''), setEverywhere(false))}>
                Clear
              </Button>
            )}
          </form>
          {query && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Search all folders
            </label>
          )}
          <div className="flex items-center gap-1 text-xs">
            {(['all', 'unread', 'flagged'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded px-2 py-1 capitalize ${filter === f ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                {f}
              </button>
            ))}
            {isTrash && items.length > 0 && (
              <button
                className="ml-auto rounded px-2 py-1 text-red-600 hover:bg-red-50"
                onClick={async () => {
                  await post(`/api/mail/folders/${current}/empty`);
                  void loadList(true);
                  void loadFolders();
                }}
              >
                Empty {folder ? folderName(folder) : ''}
              </button>
            )}
          </div>
          {sel.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 rounded-md bg-brand-50 px-2 py-1 text-xs">
              <span className="font-medium">{sel.length} selected</span>
              <Button variant="ghost" onClick={() => void act('read', sel)}>
                Read
              </Button>
              <Button variant="ghost" onClick={() => void act('unread', sel)}>
                Unread
              </Button>
              <Button variant="ghost" onClick={() => void act('flag', sel)}>
                Flag
              </Button>
              <Button variant="ghost" onClick={() => void act('delete', sel)}>
                Delete
              </Button>
              <select
                className="rounded border-slate-300 py-0.5 text-xs"
                value=""
                onChange={(e) => e.target.value && void act('move', sel, Number(e.target.value))}
                aria-label="Move selected"
              >
                <option value="">Move to…</option>
                {(folders?.folders ?? [])
                  .filter((f) => f.id !== current)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {folderName(f)}
                    </option>
                  ))}
              </select>
              <button className="ml-auto text-slate-500" onClick={() => setSelected(new Set())}>
                ✕
              </button>
            </div>
          )}
        </div>
        <ErrorBanner error={error} />
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Messages">
          {loading && !items.length && <Spinner />}
          {!loading && !items.length && <li className="py-12 text-center text-sm text-slate-500">{query ? 'No messages match your search.' : 'This folder is empty.'}</li>}
          {items.map((m) => (
            <Row
              key={m.id}
              m={m}
              active={open === m.id}
              checked={selected.has(m.id)}
              sentView={folder?.specialUse === 'sent' || folder?.specialUse === 'drafts'}
              onOpen={() => {
                setOpen(m.id);
                if (!m.seen) setItems((old) => old.map((x) => (x.id === m.id ? { ...x, seen: true } : x)));
              }}
              onCheck={(v) => {
                const s = new Set(selected);
                if (v) s.add(m.id);
                else s.delete(m.id);
                setSelected(s);
              }}
            />
          ))}
          {nextBefore && (
            <li className="p-3 text-center">
              <Button variant="secondary" onClick={() => void loadMore()}>
                Load older messages
              </Button>
            </li>
          )}
        </ul>
      </section>
      <section className={`min-w-0 flex-1 bg-slate-50 ${open ? 'block' : 'hidden md:block'}`}>
        {open ? (
          <Reader id={open} folders={folders?.folders ?? []} onAction={onReaderAction} onBack={() => setOpen(null)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-slate-500">
            <div>Select a message to read it.</div>
            {'Notification' in window && Notification.permission === 'default' && (
              <Button variant="secondary" onClick={() => void Notification.requestPermission()}>
                Turn on desktop notifications
              </Button>
            )}
            {inbox && <div className="text-xs">{inbox.unseen ? `${inbox.unseen} unread in Inbox` : 'Inbox is all read'}</div>}
          </div>
        )}
      </section>
      {compose && identities.addresses.length > 0 && (
        <Compose
          init={compose}
          identities={identities}
          onClose={() => {
            setCompose(null);
            void loadFolders();
          }}
          onSent={(msg) => {
            setCompose(null);
            setToast(msg);
            void loadFolders();
            void loadList(false);
          }}
        />
      )}
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
