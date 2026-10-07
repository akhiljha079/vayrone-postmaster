import { useEffect, useRef, useState } from 'react';
import { formatBytes, get } from '../../api';
import { Badge, Button, ErrorBanner, Select, Spinner } from '../../components/ui';
import { addrText, folderName, type Folder, type FullMessage } from './types';

const FRAME_STYLE = `
  body { font-family: "Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif; font-size: 14px; line-height: 1.5;
         color: #0f172a; margin: 0; padding: 4px 2px 16px; word-wrap: break-word; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  img[data-vpm-src] { display: none; }
  table { max-width: 100%; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 0 0 0 4px; padding-left: 12px; color: #475569; }
  a { color: #1d4ed8; }
  pre { white-space: pre-wrap; }
`;

/**
 * Builds the iframe document. The CSP blocks every network request except
 * images the user chose to show; the sandbox (no allow-scripts) blocks script.
 */
function frameDoc(html: string, images: boolean): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${images ? ' https: http:' : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${html}</body></html>`;
}

export function MailFrame({ html, images }: { html: string; images: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const measure = () => {
    const d = ref.current?.contentDocument;
    if (d?.body) setHeight(Math.max(120, d.documentElement.scrollHeight + 8));
  };
  useEffect(() => {
    const t = setInterval(measure, 400); // late-loading images change the height
    const stop = setTimeout(() => clearInterval(t), 5000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [html, images]);
  return (
    <iframe
      ref={ref}
      title="Message"
      // No allow-scripts: email content can never run code. allow-same-origin only lets us measure the height.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={frameDoc(html, images)}
      onLoad={measure}
      className="w-full border-0"
      style={{ height }}
    />
  );
}

export type ReaderAction = 'reply' | 'replyAll' | 'forward' | 'editDraft' | 'delete' | 'unread' | 'flag' | 'unflag' | 'junk' | 'not_junk' | 'ruleFromSender' | { move: number };

export function Reader({ id, folders, onAction, onBack }: { id: number; folders: Folder[]; onAction: (a: ReaderAction, m: FullMessage) => void; onBack: () => void }) {
  const [images, setImages] = useState(false);
  const [m, setM] = useState<FullMessage | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setImages(false);
    setM(null);
    setError(null);
    get<FullMessage>(`/api/mail/messages/${id}`).then(setM, setError);
  }, [id]);
  useEffect(() => {
    if (images && m?.remoteImages) get<FullMessage>(`/api/mail/messages/${id}?images=1&markRead=0`).then(setM, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  if (error) return <ErrorBanner error={error} />;
  if (!m) return <Spinner />;
  const isDraft = m.flags.draft;
  const inJunk = m.folderSpecialUse === 'junk';
  return (
    <article className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-3 py-2">
        <Button variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to list">
          ←
        </Button>
        {isDraft ? (
          <Button onClick={() => onAction('editDraft', m)}>Continue editing</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onAction('reply', m)} title="Reply (r)">
              Reply
            </Button>
            <Button variant="secondary" onClick={() => onAction('replyAll', m)}>
              Reply all
            </Button>
            <Button variant="secondary" onClick={() => onAction('forward', m)}>
              Forward
            </Button>
          </>
        )}
        <span className="mx-1 h-5 w-px bg-slate-200" />
        <Button variant="ghost" onClick={() => onAction('delete', m)} title="Delete (Del)">
          Delete
        </Button>
        <Button variant="ghost" onClick={() => onAction('unread', m)}>
          Mark unread
        </Button>
        <Button variant="ghost" onClick={() => onAction(m.flags.flagged ? 'unflag' : 'flag', m)}>
          {m.flags.flagged ? 'Unflag' : 'Flag'}
        </Button>
        <Button variant="ghost" onClick={() => onAction(inJunk ? 'not_junk' : 'junk', m)}>
          {inJunk ? 'Not junk' : 'Junk'}
        </Button>
        <Select className="w-36 py-1" value="" onChange={(e) => e.target.value && onAction({ move: Number(e.target.value) }, m)} aria-label="Move to folder">
          <option value="">Move to…</option>
          {folders
            .filter((f) => f.id !== m.folderId)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {folderName(f)}
              </option>
            ))}
        </Select>
        {m.from[0]?.address && (
          <Button variant="ghost" onClick={() => onAction('ruleFromSender', m)} title="Create a rule: mail from this sender goes to a folder">
            Always move from sender…
          </Button>
        )}
        <a className="ml-auto rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100" href={`/api/mail/messages/${m.id}/raw`}>
          Download .eml
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-5 py-4">
        <h1 className="mb-3 text-lg font-semibold text-slate-900">{m.subject || '(no subject)'}</h1>
        <div className="mb-3 space-y-0.5 text-sm">
          <div>
            <span className="font-medium text-slate-900">{m.from.map(addrText).join(', ')}</span>
            <span className="ml-2 text-xs text-slate-500">{new Date(m.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            {m.flags.flagged && (
              <span className="ml-2">
                <Badge color="amber">Flagged</Badge>
              </span>
            )}
          </div>
          {m.to.length > 0 && <div className="text-slate-600">To: {m.to.map(addrText).join(', ')}</div>}
          {m.cc.length > 0 && <div className="text-slate-600">Cc: {m.cc.map(addrText).join(', ')}</div>}
          {m.bcc.length > 0 && <div className="text-slate-600">Bcc: {m.bcc.map(addrText).join(', ')}</div>}
        </div>
        {m.remoteImages && !images && (
          <div className="mb-3 flex items-center justify-between rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
            <span>Pictures from the internet were blocked to protect your privacy.</span>
            <Button variant="secondary" onClick={() => setImages(true)}>
              Show images
            </Button>
          </div>
        )}
        {m.attachments.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {m.attachments.map((a) => (
              <a
                key={a.index}
                href={`/api/mail/messages/${m.id}/attachments/${a.index}`}
                className="flex items-center gap-2 rounded-md bg-slate-50 px-3 py-1.5 text-sm ring-1 ring-slate-200 hover:bg-slate-100"
              >
                <span aria-hidden>📎</span>
                <span className="max-w-[16rem] truncate">{a.filename}</span>
                <span className="text-xs text-slate-500">{formatBytes(a.size)}</span>
              </a>
            ))}
          </div>
        )}
        <MailFrame html={m.html} images={images} />
      </div>
    </article>
  );
}
