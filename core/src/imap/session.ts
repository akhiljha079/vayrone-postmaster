// IMAP4rev1 session (RFC 3501) with IDLE, UIDPLUS, MOVE, SPECIAL-USE,
// NAMESPACE, ID, ENABLE, UNSELECT, CHILDREN, LITERAL+, SASL-IR, CONDSTORE.
//
// Each connection keeps a "view" of the selected folder: the UID list in
// sequence order plus the MODSEQ up to which it has reported changes. Any
// change to the folder (from this or another connection, SMTP delivery, POP3,
// the fetcher) bumps folders.highest_modseq; the session re-syncs from the DB
// and emits EXISTS / EXPUNGE / FETCH FLAGS. The DB is the single source of
// truth, so a missed in-process event can only delay, never lose, an update.
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { CoreContext } from '../context.js';
import type { AuthUser } from '../directory.js';
import type { Folder } from '../store/mailstore.js';
import { StoreError, SEEN_BIT } from '../store/mailstore.js';
import { APP_VERSION } from '../migrate.js';
import type { Command, IVal, Token } from './protocol.js';
import {
  ImapParseError,
  compressSet,
  decodeMailboxName,
  encodeItems,
  flagsToList,
  inSeqSet,
  mailboxName,
  parseCommand,
  parseFlags,
  parseInternalDate,
  parseSeqSet,
  tokenString,
} from './protocol.js';
import type { FetchAttr } from './fetch.js';
import { buildFetchItems, needsMessageData, parseFetchRequest, setsSeen } from './fetch.js';
import type { SearchItem } from './search.js';
import { decodedHeaders, evaluate, extractBodyText, parseSearch, searchNeeds } from './search.js';

type State = 'notauth' | 'auth' | 'selected' | 'logout';

interface Result {
  s: 'OK' | 'NO' | 'BAD';
  code?: string;
  text: string;
  /** EXPUNGE responses may not be sent after FETCH/STORE/SEARCH (non-UID). */
  expunge?: boolean;
  noSync?: boolean;
}

interface View {
  folder: Folder;
  readOnly: boolean;
  uids: number[];
  maxUid: number;
  flagModseq: number;
  expungeModseq: number;
  unsubscribe: () => void;
}

const FLAGS_ATTR: FetchAttr = { kind: 'FLAGS', label: 'FLAGS' };
const UID_ATTR: FetchAttr = { kind: 'UID', label: 'UID' };
const MODSEQ_ATTR: FetchAttr = { kind: 'MODSEQ', label: 'MODSEQ' };
const SYSTEM_FLAGS = '\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded $Junk $NotJunk';
const SPECIAL_ATTR: Record<string, string> = { sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', junk: '\\Junk', archive: '\\Archive' };
const PREAUTH_TIMEOUT = 5 * 60_000;
const AUTH_TIMEOUT = 31 * 60_000;

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

function astring(t: Token | undefined, what = 'argument'): string {
  const s = tokenString(t);
  if (s === null) throw new ImapParseError(`Missing ${what}`);
  return s;
}

function atomArg(t: Token | undefined, what = 'argument'): string {
  if (!t || t.t !== 'atom') throw new ImapParseError(`Missing ${what}`);
  return t.v;
}

/** Splits the stream into complete commands, collecting literals. */
class CommandReader {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private literalLeft = 0;

  constructor(
    private readonly onCommand: (b: Buffer) => void,
    private readonly onLiteralWait: () => void,
    private readonly onError: (msg: string) => void,
    private readonly maxLiteral: number,
  ) {}

  push(chunkIn: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunkIn]) : chunkIn;
    for (;;) {
      if (this.literalLeft > 0) {
        if (!this.buf.length) return;
        const take = Math.min(this.literalLeft, this.buf.length);
        this.parts.push(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.literalLeft -= take;
        if (this.literalLeft > 0) return;
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) {
        if (this.buf.length > 65536) {
          this.reset();
          this.onError('Command line too long');
        }
        return;
      }
      const line = this.buf.subarray(0, nl + 1);
      this.buf = this.buf.subarray(nl + 1);
      this.parts.push(line);
      const m = /\{(\d+)(\+)?\}\r?\n$/.exec(line.toString('latin1', Math.max(0, line.length - 24)));
      if (m) {
        const n = Number(m[1]);
        if (n > this.maxLiteral) {
          this.reset();
          this.onError('Literal too large');
          return;
        }
        this.literalLeft = n;
        if (!m[2]) this.onLiteralWait();
        continue;
      }
      const cmd = Buffer.concat(this.parts);
      this.parts = [];
      this.onCommand(cmd);
    }
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.literalLeft = 0;
  }
}

export class ImapSession {
  readonly id = randomBytes(4).toString('hex');
  private sock: Socket;
  private state: State = 'notauth';
  private user: AuthUser | null = null;
  private view: View | null = null;
  private reader: CommandReader;
  private chain: Promise<void> = Promise.resolve();
  private syncLock: Promise<void> = Promise.resolve();
  private lineHook: ((b: Buffer | null) => void) | null = null;
  private condstore = false;
  private idling = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  /** uid → modseq of changes this session made itself (not echoed back as unsolicited FETCH). */
  private ownChanges = new Map<number, number>();
  private readonly remoteIp: string;

  constructor(
    private readonly ctx: CoreContext,
    socket: Socket,
    private secure: boolean,
    private readonly onClose: (s: ImapSession) => void,
  ) {
    this.sock = socket;
    this.remoteIp = socket.remoteAddress ?? '';
    this.reader = new CommandReader(
      (b) => this.onCommand(b),
      () => this.send('+ Ready for literal data'),
      (msg) => {
        this.send(`* BAD ${msg}`);
      },
      ctx.config.maxMessageSize + 1024 * 1024,
    );
  }

  start(): void {
    this.attach(this.sock);
    this.send(`* OK [CAPABILITY ${this.capabilities()}] Vayrone PostMaster IMAP4rev1 ready`);
  }

  // ---------------------------------------------------------------------------
  // I/O
  // ---------------------------------------------------------------------------

  private attach(sock: Socket): void {
    this.sock = sock;
    sock.on('data', (c: Buffer) => {
      this.touch();
      this.reader.push(c);
    });
    sock.on('error', () => this.close());
    sock.on('close', () => this.close());
    this.touch();
  }

  private touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.send('* BYE Autologout; idle for too long');
        this.close();
      },
      this.state === 'notauth' ? PREAUTH_TIMEOUT : AUTH_TIMEOUT,
    );
    this.timer.unref();
  }

  private send(line: string | Buffer): void {
    if (this.closed) return;
    this.sock.write(typeof line === 'string' ? line + '\r\n' : line);
  }

  private async sendAsync(b: Buffer): Promise<void> {
    if (this.closed) return;
    if (!this.sock.write(b)) {
      await Promise.race([once(this.sock, 'drain'), once(this.sock, 'close')]);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.view?.unsubscribe();
    this.view = null;
    this.lineHook?.(null);
    this.lineHook = null;
    this.sock.destroySoon?.();
    this.sock.end();
    this.onClose(this);
  }

  private onCommand(b: Buffer): void {
    if (this.lineHook) {
      const h = this.lineHook;
      this.lineHook = null;
      h(b);
      return;
    }
    this.chain = this.chain
      .then(() => this.handle(b))
      .catch((err) => {
        this.ctx.log.error({ err, session: this.id }, 'imap session error');
        this.close();
      });
  }

  /** Waits for the next raw client line (AUTHENTICATE continuation, IDLE DONE). */
  private nextLine(): Promise<Buffer | null> {
    return new Promise((resolve) => {
      this.lineHook = resolve;
    });
  }

  private capabilities(): string {
    const caps = ['IMAP4rev1', 'LITERAL+', 'SASL-IR', 'ID', 'ENABLE', 'IDLE', 'NAMESPACE', 'UNSELECT', 'UIDPLUS', 'MOVE', 'SPECIAL-USE', 'CHILDREN', 'CONDSTORE'];
    if (this.state === 'notauth') {
      if (!this.secure) caps.push('STARTTLS');
      if (!this.secure && !this.ctx.config.allowPlaintextAuth) caps.push('LOGINDISABLED');
      else caps.push('AUTH=PLAIN', 'AUTH=LOGIN');
    }
    return caps.join(' ');
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  private async handle(b: Buffer): Promise<void> {
    let cmd: Command;
    try {
      cmd = parseCommand(b);
    } catch (e) {
      const pe = e as ImapParseError;
      this.send(`${pe.tag ?? '*'} BAD ${pe.message}`);
      return;
    }
    const h = this.handlerFor(cmd.name);
    if (!h) {
      this.send(`${cmd.tag} BAD Unknown command ${cmd.name}`);
      return;
    }
    if (!h.states.includes(this.state)) {
      this.send(`${cmd.tag} BAD ${cmd.name} not allowed now`);
      return;
    }
    let res: Result | undefined;
    try {
      res = await h.fn(cmd);
    } catch (e) {
      if (e instanceof ImapParseError) res = { s: 'BAD', text: e.message };
      else if (e instanceof StoreError) res = { s: 'NO', code: e.code, text: e.message };
      else {
        this.ctx.log.error({ err: e, cmd: cmd.name, session: this.id }, 'imap command failed');
        res = { s: 'NO', code: 'SERVERBUG', text: 'Internal server error' };
      }
    }
    if (!res) return;
    if (this.state === 'selected' && !res.noSync) {
      try {
        await this.sync(res.expunge ?? true);
      } catch (e) {
        this.ctx.log.error({ err: e, session: this.id }, 'imap sync failed');
      }
    }
    this.send(`${cmd.tag} ${res.s}${res.code ? ` [${res.code}]` : ''} ${res.text}`);
  }

  private handlerFor(name: string): { states: State[]; fn: (c: Command) => Promise<Result | undefined> } | null {
    const any: State[] = ['notauth', 'auth', 'selected'];
    const authed: State[] = ['auth', 'selected'];
    const sel: State[] = ['selected'];
    const map: Record<string, [State[], (c: Command) => Promise<Result | undefined>]> = {
      CAPABILITY: [any, async () => (this.send(`* CAPABILITY ${this.capabilities()}`), { s: 'OK', text: 'CAPABILITY completed' })],
      NOOP: [any, async () => ({ s: 'OK', text: 'NOOP completed' })],
      CHECK: [sel, async () => ({ s: 'OK', text: 'CHECK completed' })],
      LOGOUT: [any, (c) => this.cmdLogout(c)],
      ID: [any, (c) => this.cmdId(c)],
      STARTTLS: [['notauth'], (c) => this.cmdStartTls(c)],
      LOGIN: [['notauth'], (c) => this.cmdLogin(c)],
      AUTHENTICATE: [['notauth'], (c) => this.cmdAuthenticate(c)],
      NAMESPACE: [authed, async () => (this.send('* NAMESPACE (("" "/")) NIL NIL'), { s: 'OK', text: 'NAMESPACE completed' })],
      ENABLE: [authed, (c) => this.cmdEnable(c)],
      SELECT: [authed, (c) => this.cmdSelect(c, false)],
      EXAMINE: [authed, (c) => this.cmdSelect(c, true)],
      CREATE: [authed, (c) => this.cmdCreate(c)],
      DELETE: [authed, (c) => this.cmdDelete(c)],
      RENAME: [authed, (c) => this.cmdRename(c)],
      SUBSCRIBE: [authed, (c) => this.cmdSubscribe(c, true)],
      UNSUBSCRIBE: [authed, (c) => this.cmdSubscribe(c, false)],
      LIST: [authed, (c) => this.cmdList(c, false)],
      LSUB: [authed, (c) => this.cmdList(c, true)],
      STATUS: [authed, (c) => this.cmdStatus(c)],
      APPEND: [authed, (c) => this.cmdAppend(c)],
      IDLE: [authed, (c) => this.cmdIdle(c)],
      CLOSE: [sel, (c) => this.cmdClose(c, true)],
      UNSELECT: [sel, (c) => this.cmdClose(c, false)],
      EXPUNGE: [sel, (c) => this.cmdExpunge(c, false)],
      'UID EXPUNGE': [sel, (c) => this.cmdExpunge(c, true)],
      FETCH: [sel, (c) => this.cmdFetch(c, false)],
      'UID FETCH': [sel, (c) => this.cmdFetch(c, true)],
      STORE: [sel, (c) => this.cmdStore(c, false)],
      'UID STORE': [sel, (c) => this.cmdStore(c, true)],
      SEARCH: [sel, (c) => this.cmdSearch(c, false)],
      'UID SEARCH': [sel, (c) => this.cmdSearch(c, true)],
      COPY: [sel, (c) => this.cmdCopy(c, false, false)],
      'UID COPY': [sel, (c) => this.cmdCopy(c, true, false)],
      MOVE: [sel, (c) => this.cmdCopy(c, false, true)],
      'UID MOVE': [sel, (c) => this.cmdCopy(c, true, true)],
    };
    const e = map[name];
    return e ? { states: e[0], fn: e[1] } : null;
  }

  // ---------------------------------------------------------------------------
  // Non-authenticated / any state
  // ---------------------------------------------------------------------------

  private async cmdLogout(c: Command): Promise<undefined> {
    this.send('* BYE Vayrone PostMaster logging out');
    this.send(`${c.tag} OK LOGOUT completed`);
    this.state = 'logout';
    this.close();
    return undefined;
  }

  private async cmdId(_c: Command): Promise<Result> {
    this.send(`* ID ("name" "Vayrone PostMaster" "vendor" "Vayrone Infratech" "version" "${APP_VERSION}")`);
    return { s: 'OK', text: 'ID completed' };
  }

  private async cmdStartTls(c: Command): Promise<undefined> {
    if (this.secure) {
      this.send(`${c.tag} BAD Already using TLS`);
      return undefined;
    }
    this.send(`${c.tag} OK Begin TLS negotiation now`);
    const plain = this.sock;
    plain.removeAllListeners('data');
    plain.removeAllListeners('close');
    plain.removeAllListeners('error');
    this.reader.reset();
    const secure = new TLSSocket(plain, { isServer: true, secureContext: this.ctx.tls.context });
    this.secure = true;
    secure.on('secure', () => {});
    this.attach(secure);
    return undefined;
  }

  private plaintextBlocked(): boolean {
    return !this.secure && !this.ctx.config.allowPlaintextAuth;
  }

  private async finishLogin(u: AuthUser | null): Promise<Result> {
    if (!u) return { s: 'NO', code: 'AUTHENTICATIONFAILED', text: 'Invalid credentials' };
    this.user = u;
    this.state = 'auth';
    this.touch();
    return { s: 'OK', code: `CAPABILITY ${this.capabilities()}`, text: 'Logged in' };
  }

  private async cmdLogin(c: Command): Promise<Result> {
    if (this.plaintextBlocked()) return { s: 'NO', code: 'PRIVACYREQUIRED', text: 'Use STARTTLS first' };
    const user = astring(c.args[0], 'user');
    const pass = astring(c.args[1], 'password');
    return this.finishLogin(await this.ctx.directory.authenticate(user, pass, 'imap', this.remoteIp));
  }

  private async cmdAuthenticate(c: Command): Promise<Result> {
    if (this.plaintextBlocked()) return { s: 'NO', code: 'PRIVACYREQUIRED', text: 'Use STARTTLS first' };
    const mech = atomArg(c.args[0], 'mechanism').toUpperCase();
    const ir = c.args[1] ? astring(c.args[1]) : null;
    const ask = async (prompt: string): Promise<string | null> => {
      this.send(`+ ${prompt}`);
      const line = await this.nextLine();
      if (!line) return null;
      const s = line.toString('latin1').trim();
      return s === '*' ? null : s;
    };
    if (mech === 'PLAIN') {
      const data = ir !== null ? (ir === '=' ? '' : ir) : await ask('');
      if (data === null) return { s: 'BAD', text: 'Authentication cancelled' };
      const parts = Buffer.from(data, 'base64').toString('utf8').split('\0');
      if (parts.length !== 3) return { s: 'BAD', text: 'Invalid PLAIN data' };
      return this.finishLogin(await this.ctx.directory.authenticate(parts[1]!, parts[2]!, 'imap', this.remoteIp));
    }
    if (mech === 'LOGIN') {
      const u64 = ir ?? (await ask(Buffer.from('Username:').toString('base64')));
      if (u64 === null) return { s: 'BAD', text: 'Authentication cancelled' };
      const p64 = await ask(Buffer.from('Password:').toString('base64'));
      if (p64 === null) return { s: 'BAD', text: 'Authentication cancelled' };
      const user = Buffer.from(u64, 'base64').toString('utf8');
      const pass = Buffer.from(p64, 'base64').toString('utf8');
      return this.finishLogin(await this.ctx.directory.authenticate(user, pass, 'imap', this.remoteIp));
    }
    return { s: 'NO', text: 'Unsupported authentication mechanism' };
  }

  // ---------------------------------------------------------------------------
  // Authenticated state
  // ---------------------------------------------------------------------------

  private get uid(): number {
    return this.user!.id;
  }

  private async cmdEnable(c: Command): Promise<Result> {
    const enabled: string[] = [];
    for (const t of c.args) {
      if (t.t === 'atom' && t.v.toUpperCase() === 'CONDSTORE') {
        this.condstore = true;
        enabled.push('CONDSTORE');
      }
    }
    this.send(`* ENABLED${enabled.length ? ' ' + enabled.join(' ') : ''}`);
    return { s: 'OK', text: 'ENABLE completed' };
  }

  private deselect(): void {
    this.view?.unsubscribe();
    this.view = null;
    this.ownChanges.clear();
    this.state = 'auth';
  }

  private async cmdSelect(c: Command, readOnly: boolean): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const params = c.args[1];
    if (params?.t === 'list' && params.v.some((t) => t.t === 'atom' && t.v.toUpperCase() === 'CONDSTORE')) this.condstore = true;
    if (this.view) {
      this.deselect();
      this.send('* OK [CLOSED] Previous mailbox closed');
    }
    const folder = await this.ctx.store.getFolder(this.uid, name);
    if (!folder) return { s: 'NO', code: 'NONEXISTENT', text: 'No such mailbox' };
    const uids = await this.ctx.store.listUids(folder.id);
    const maxUid = uids.length ? uids[uids.length - 1]! : 0;
    const view: View = {
      folder,
      readOnly,
      uids,
      maxUid,
      flagModseq: Number(folder.highest_modseq),
      expungeModseq: Number(folder.highest_modseq),
      unsubscribe: () => {},
    };
    view.unsubscribe = this.ctx.events.onFolder(folder.id, () => this.onFolderEvent());
    this.view = view;
    this.state = 'selected';

    const firstUnseen = await this.ctx.store.firstUnseenUid(folder.id);
    this.send(`* FLAGS (${SYSTEM_FLAGS})`);
    this.send(`* OK [PERMANENTFLAGS (${readOnly ? '' : SYSTEM_FLAGS + ' \\*'})] Flags permitted`);
    this.send(`* ${uids.length} EXISTS`);
    this.send('* 0 RECENT');
    if (firstUnseen !== null) {
      const seq = this.seqOf(firstUnseen);
      if (seq > 0) this.send(`* OK [UNSEEN ${seq}] First unseen`);
    }
    this.send(`* OK [UIDVALIDITY ${folder.uidvalidity}] UIDs valid`);
    this.send(`* OK [UIDNEXT ${Math.max(folder.uidnext, maxUid + 1)}] Predicted next UID`);
    this.send(`* OK [HIGHESTMODSEQ ${folder.highest_modseq}] Highest`);
    return { s: 'OK', code: readOnly ? 'READ-ONLY' : 'READ-WRITE', text: `${readOnly ? 'EXAMINE' : 'SELECT'} completed`, noSync: true };
  }

  private async cmdCreate(c: Command): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox')).replace(/\/+$/, '');
    if (name.toUpperCase() === 'INBOX') return { s: 'NO', code: 'ALREADYEXISTS', text: 'INBOX already exists' };
    await this.ctx.store.createFolder(this.uid, name);
    return { s: 'OK', text: 'CREATE completed' };
  }

  private async cmdDelete(c: Command): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const f = await this.ctx.store.getFolder(this.uid, name);
    if (f && this.view?.folder.id === f.id) this.deselect();
    await this.ctx.store.deleteFolder(this.uid, name);
    return { s: 'OK', text: 'DELETE completed' };
  }

  private async cmdRename(c: Command): Promise<Result> {
    const from = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const to = decodeMailboxName(astring(c.args[1], 'new name'));
    await this.ctx.store.renameFolder(this.uid, from, to);
    return { s: 'OK', text: 'RENAME completed' };
  }

  private async cmdSubscribe(c: Command, on: boolean): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const ok = await this.ctx.store.setSubscribed(this.uid, name, on);
    if (!ok && on) return { s: 'NO', code: 'NONEXISTENT', text: 'No such mailbox' };
    return { s: 'OK', text: `${on ? 'SUBSCRIBE' : 'UNSUBSCRIBE'} completed` };
  }

  private async cmdList(c: Command, lsub: boolean): Promise<Result> {
    const args = [...c.args];
    let specialOnly = false;
    let subscribedOnly = lsub;
    if (args[0]?.t === 'list') {
      // LIST-EXTENDED selection options (tolerated for clients that send them anyway)
      for (const t of args[0].v) {
        const v = tokenString(t)?.toUpperCase();
        if (v === 'SPECIAL-USE') specialOnly = true;
        if (v === 'SUBSCRIBED') subscribedOnly = true;
      }
      args.shift();
    }
    const ref = decodeMailboxName(astring(args[0], 'reference'));
    const pattern = decodeMailboxName(astring(args[1], 'pattern'));
    const verb = lsub ? 'LSUB' : 'LIST';
    if (pattern === '') {
      this.send(`* ${verb} (\\Noselect) "/" ""`);
      return { s: 'OK', text: `${verb} completed` };
    }
    const full = ref && !pattern.startsWith('/') ? ref.replace(/\/?$/, '/') + pattern : pattern;
    const rx = new RegExp(
      '^' +
        full
          .split('')
          .map((ch) => (ch === '*' ? '.*' : ch === '%' ? '[^/]*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
          .join('') +
        '$',
      'i',
    );
    const folders = await this.ctx.store.listFolders(this.uid);
    const hasChildren = new Set(folders.filter((f) => f.parent_id !== null).map((f) => f.parent_id));
    for (const f of folders) {
      if (!rx.test(f.path)) continue;
      if (subscribedOnly && !f.subscribed) continue;
      if (specialOnly && !SPECIAL_ATTR[f.special_use ?? '']) continue;
      const attrs: IVal[] = [{ atom: hasChildren.has(f.id) ? '\\HasChildren' : '\\HasNoChildren' }];
      const su = SPECIAL_ATTR[f.special_use ?? ''];
      if (su) attrs.push({ atom: su });
      this.send(Buffer.concat([Buffer.from(`* ${verb} `), encodeItems([attrs, '/', mailboxName(f.path)]), Buffer.from('\r\n')]));
    }
    return { s: 'OK', text: `${verb} completed` };
  }

  private async cmdStatus(c: Command): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const items = c.args[1];
    if (!items || items.t !== 'list') throw new ImapParseError('STATUS items expected');
    const f = await this.ctx.store.getFolder(this.uid, name);
    if (!f) return { s: 'NO', code: 'NONEXISTENT', text: 'No such mailbox' };
    const out: IVal[] = [];
    for (const t of items.v) {
      const k = tokenString(t)?.toUpperCase();
      if (k === 'MESSAGES') out.push({ atom: k }, f.message_count);
      else if (k === 'RECENT') out.push({ atom: k }, 0);
      else if (k === 'UIDNEXT') out.push({ atom: k }, f.uidnext);
      else if (k === 'UIDVALIDITY') out.push({ atom: k }, f.uidvalidity);
      else if (k === 'UNSEEN') out.push({ atom: k }, f.unseen_count);
      else if (k === 'HIGHESTMODSEQ') {
        this.condstore = true;
        out.push({ atom: k }, Number(f.highest_modseq));
      } else if (k === 'SIZE') out.push({ atom: k }, Number(f.total_bytes));
      else throw new ImapParseError(`Unknown STATUS item ${k}`);
    }
    this.send(Buffer.concat([Buffer.from('* STATUS '), encodeItems([mailboxName(f.path), out]), Buffer.from('\r\n')]));
    return { s: 'OK', text: 'STATUS completed' };
  }

  private async cmdAppend(c: Command): Promise<Result> {
    const name = decodeMailboxName(astring(c.args[0], 'mailbox'));
    const msgTok = c.args[c.args.length - 1];
    if (c.args.length < 2 || !msgTok || msgTok.t !== 'string') throw new ImapParseError('Message literal expected');
    let flags = 0;
    let keywords: string[] = [];
    let date: Date | undefined;
    for (const t of c.args.slice(1, -1)) {
      if (t.t === 'list') {
        const f = parseFlags(t.v.map((x) => tokenString(x) ?? ''));
        flags = f.bits;
        keywords = f.keywords;
      } else {
        const d = parseInternalDate(tokenString(t) ?? '');
        if (!d) throw new ImapParseError('Invalid date-time');
        date = d;
      }
    }
    if (!msgTok.v.length) return { s: 'NO', text: 'Empty message' };
    const f = await this.ctx.store.getFolder(this.uid, name);
    if (!f) return { s: 'NO', code: 'TRYCREATE', text: 'No such mailbox' };
    await this.ctx.store.assertQuota(this.uid, msgTok.v.length);
    const message = await this.ctx.store.ingest(msgTok.v);
    const r = await this.ctx.store.append({
      userId: this.uid,
      folderId: f.id,
      message,
      flags,
      keywords,
      ...(date ? { internalDate: date } : {}),
      origin: 'imap_append',
    });
    return { s: 'OK', code: `APPENDUID ${r.uidvalidity} ${r.uid}`, text: 'APPEND completed' };
  }

  private async cmdIdle(c: Command): Promise<undefined> {
    this.send('+ idling');
    this.idling = true;
    const done = this.nextLine();
    const keepalive = setInterval(() => this.send('* OK Still here'), 120_000);
    try {
      if (this.view) await this.sync(true);
      const line = await done;
      if (!line) return undefined; // connection closed
      const ok = line.toString('latin1').trim().toUpperCase() === 'DONE';
      this.idling = false;
      if (this.view) await this.sync(true);
      this.send(ok ? `${c.tag} OK IDLE terminated` : `${c.tag} BAD Expected DONE`);
      return undefined;
    } finally {
      clearInterval(keepalive);
      this.idling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Selected state
  // ---------------------------------------------------------------------------

  private seqOf(uid: number): number {
    const a = this.view!.uids;
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = a[mid]!;
      if (v === uid) return mid + 1;
      if (v < uid) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Resolves a sequence set (by sequence number or UID) to UIDs in the current view. */
  private resolveSet(set: string, uidMode: boolean): number[] {
    const v = this.view!;
    const ranges = parseSeqSet(set);
    if (uidMode) {
      const max = v.uids.length ? v.uids[v.uids.length - 1]! : 0;
      if (!max) return [];
      return v.uids.filter((u) => inSeqSet(ranges, u, max));
    }
    const n = v.uids.length;
    for (const [a, b] of ranges) {
      if ((a !== Infinity && a > n) || (b !== Infinity && b > n)) throw new ImapParseError('Invalid message sequence number');
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (inSeqSet(ranges, i + 1, n)) out.push(v.uids[i]!);
    return out;
  }

  private onFolderEvent(): void {
    if (this.idling && !this.closed) {
      this.sync(true).catch((err) => this.ctx.log.error({ err, session: this.id }, 'imap idle sync failed'));
    }
  }

  private sync(allowExpunge: boolean): Promise<void> {
    const p = this.syncLock.then(() => this.doSync(allowExpunge));
    this.syncLock = p.catch(() => {});
    return p;
  }

  private async doSync(allowExpunge: boolean): Promise<void> {
    const v = this.view;
    if (!v || this.closed) return;
    const ch = await this.ctx.store.changesSince(v.folder.id, v.flagModseq, v.expungeModseq, v.maxUid);
    if (!ch || this.view !== v) return;

    if (allowExpunge) {
      const gone = ch.expunged.map((e) => e.uid).sort((a, b) => b - a);
      for (const uid of gone) {
        const seq = this.seqOf(uid);
        if (seq > 0) {
          this.send(`* ${seq} EXPUNGE`);
          v.uids.splice(seq - 1, 1);
        }
      }
      v.expungeModseq = ch.highestModseq;
    }

    const prevMax = v.maxUid;
    const fresh = ch.newUids.filter((u) => u > prevMax);
    if (fresh.length) {
      v.uids.push(...fresh);
      v.maxUid = fresh[fresh.length - 1]!;
      this.send(`* ${v.uids.length} EXISTS`);
    }

    for (const it of ch.changed) {
      if (it.uid > prevMax) continue;
      if (this.ownChanges.get(it.uid) === Number(it.modseq)) continue;
      const seq = this.seqOf(it.uid);
      if (seq < 0) continue;
      const items: IVal[] = [{ atom: 'UID' }, it.uid, { atom: 'FLAGS' }, flagsToList(it.flags, it.keywords)];
      if (this.condstore) items.push({ atom: 'MODSEQ' }, [Number(it.modseq)]);
      this.send(Buffer.concat([Buffer.from(`* ${seq} FETCH (`), encodeItems(items), Buffer.from(')\r\n')]));
    }
    v.flagModseq = ch.highestModseq;
    this.ownChanges.clear();
  }

  private async cmdClose(_c: Command, expunge: boolean): Promise<Result> {
    const v = this.view!;
    if (expunge && !v.readOnly) await this.ctx.store.expunge(v.folder.id);
    this.deselect();
    return { s: 'OK', text: `${expunge ? 'CLOSE' : 'UNSELECT'} completed`, noSync: true };
  }

  private async cmdExpunge(c: Command, uidMode: boolean): Promise<Result> {
    const v = this.view!;
    if (v.readOnly) return { s: 'NO', code: 'READ-ONLY', text: 'Mailbox is read-only' };
    const only = uidMode ? this.resolveSet(atomArg(c.args[0], 'UID set'), true) : undefined;
    if (only && !only.length) return { s: 'OK', text: 'EXPUNGE completed' };
    await this.ctx.store.expunge(v.folder.id, only);
    return { s: 'OK', text: 'EXPUNGE completed' };
  }

  private async cmdFetch(c: Command, uidMode: boolean): Promise<Result> {
    const v = this.view!;
    const set = atomArg(c.args[0], 'sequence set');
    const req = parseFetchRequest(c.args.slice(1));
    const attrs = [...req.attrs];
    if (uidMode && !attrs.some((a) => a.kind === 'UID')) attrs.unshift(UID_ATTR);
    if (req.changedSince !== undefined) {
      this.condstore = true;
      if (!attrs.some((a) => a.kind === 'MODSEQ')) attrs.push(MODSEQ_ATTR);
    }
    if (attrs.some((a) => a.kind === 'MODSEQ')) this.condstore = true;
    const uids = this.resolveSet(set, uidMode);
    const full = needsMessageData(attrs);
    const markSeen = !v.readOnly && setsSeen(attrs);
    const store = this.ctx.store;

    for (const part of chunk(uids, 500)) {
      let items = full ? await store.itemsFull(v.folder.id, part) : await store.itemsMeta(v.folder.id, part);
      if (req.changedSince !== undefined) items = items.filter((i) => Number(i.modseq) > req.changedSince!);
      const newlySeen = new Set<number>();
      if (markSeen) {
        const need = items.filter((i) => !(i.flags & SEEN_BIT)).map((i) => i.uid);
        if (need.length) {
          const r = await store.storeFlags(v.folder.id, need, 'add', SEEN_BIT, null);
          need.forEach((u) => newlySeen.add(u));
          for (const it of items) {
            if (newlySeen.has(it.uid)) {
              it.flags |= SEEN_BIT;
              it.modseq = r.modseq;
              this.ownChanges.set(it.uid, r.modseq);
            }
          }
        }
      }
      for (const it of items) {
        const seq = this.seqOf(it.uid);
        if (seq < 0) continue;
        const its = newlySeen.has(it.uid) && !attrs.some((a) => a.kind === 'FLAGS') ? [...attrs, FLAGS_ATTR] : attrs;
        const values = await buildFetchItems(it, its, {
          includeModseq: this.condstore && its.some((a) => a.kind === 'FLAGS'),
          loadRaw: (i) => store.loadRaw(i),
        });
        await this.sendAsync(Buffer.concat([Buffer.from(`* ${seq} FETCH (`), encodeItems(values), Buffer.from(')\r\n')]));
      }
    }
    return { s: 'OK', text: 'FETCH completed', expunge: uidMode };
  }

  private async cmdStore(c: Command, uidMode: boolean): Promise<Result> {
    const v = this.view!;
    const set = atomArg(c.args[0], 'sequence set');
    let i = 1;
    let unchangedSince: number | undefined;
    const mods = c.args[1];
    if (mods?.t === 'list') {
      const k = tokenString(mods.v[0])?.toUpperCase();
      const n = tokenString(mods.v[1]);
      if (k !== 'UNCHANGEDSINCE' || !n || !/^\d+$/.test(n)) throw new ImapParseError('Invalid STORE modifier');
      unchangedSince = Number(n);
      this.condstore = true;
      i = 2;
    }
    const item = atomArg(c.args[i], 'STORE item').toUpperCase();
    const m = /^([+-]?)FLAGS(\.SILENT)?$/.exec(item);
    if (!m) throw new ImapParseError('Invalid STORE item');
    const rest = c.args.slice(i + 1);
    const names = (rest.length === 1 && rest[0]!.t === 'list' ? rest[0]!.v : rest).map((t) => {
      if (t.t !== 'atom') throw new ImapParseError('Flag expected');
      return t.v;
    });
    const { bits, keywords } = parseFlags(names);
    if (v.readOnly) return { s: 'NO', code: 'READ-ONLY', text: 'Mailbox is read-only' };
    const mode = m[1] === '+' ? 'add' : m[1] === '-' ? 'remove' : 'set';
    const uids = this.resolveSet(set, uidMode);
    const res = await this.ctx.store.storeFlags(v.folder.id, uids, mode, bits, mode === 'set' || keywords.length ? keywords : null, unchangedSince);
    for (const u of res.changed) this.ownChanges.set(u, res.modseq);

    if (!m[2]) {
      const failed = new Set(res.failed);
      const items = await this.ctx.store.itemsMeta(v.folder.id, uids.filter((u) => !failed.has(u)));
      for (const it of items) {
        const seq = this.seqOf(it.uid);
        if (seq < 0) continue;
        const vals: IVal[] = [{ atom: 'FLAGS' }, flagsToList(it.flags, it.keywords)];
        if (uidMode) vals.unshift({ atom: 'UID' }, it.uid);
        if (this.condstore) vals.push({ atom: 'MODSEQ' }, [Number(it.modseq)]);
        this.send(Buffer.concat([Buffer.from(`* ${seq} FETCH (`), encodeItems(vals), Buffer.from(')\r\n')]));
      }
    }
    if (res.failed.length) {
      const ids = uidMode ? res.failed : res.failed.map((u) => this.seqOf(u)).filter((s) => s > 0);
      return { s: 'OK', code: `MODIFIED ${compressSet(ids)}`, text: 'Conditional STORE failed for some messages', expunge: uidMode };
    }
    return { s: 'OK', text: 'STORE completed', expunge: uidMode };
  }

  private async cmdSearch(c: Command, uidMode: boolean): Promise<Result> {
    const v = this.view!;
    const { node, charset } = parseSearch(c.args);
    if (charset && !['UTF-8', 'US-ASCII'].includes(charset)) return { s: 'NO', code: 'BADCHARSET (UTF-8 US-ASCII)', text: 'Unsupported charset' };
    const needs = searchNeeds(node);
    if (needs.modseq) this.condstore = true;
    const store = this.ctx.store;
    const maxSeq = v.uids.length;
    const maxUid = v.maxUid;
    const hits: number[] = [];
    let highestHitModseq = 0;
    for (const part of chunk([...v.uids], 2000)) {
      const items = needs.headers || needs.body ? await store.itemsFull(v.folder.id, part) : await store.itemsMeta(v.folder.id, part);
      for (const it of items) {
        const seq = this.seqOf(it.uid);
        if (seq < 0) continue;
        const s: SearchItem = { seq, item: it, maxSeq, maxUid };
        if (needs.headers || needs.body) {
          const full = it as import('../store/mailstore.js').ItemFull;
          const raw = needs.body ? await store.loadRaw(full) : null;
          const hdr = full.header_raw ?? (raw ? raw.subarray(0, full.tree.bs) : (await store.loadRaw(full)).subarray(0, full.tree.bs));
          s.headers = decodedHeaders(hdr);
          const dh = s.headers.get('date')?.[0];
          const sd = dh ? new Date(dh) : null;
          s.sentDate = sd && !Number.isNaN(sd.getTime()) ? sd : null;
          if (raw) {
            s.bodyText = extractBodyText(raw, full.tree);
            s.headerText = [...s.headers.entries()].map(([k, vals]) => `${k}: ${vals.join(' ')}`).join('\n').toLowerCase();
          }
        }
        if (evaluate(node, s)) {
          hits.push(uidMode ? it.uid : seq);
          highestHitModseq = Math.max(highestHitModseq, Number(it.modseq));
        }
      }
    }
    hits.sort((a, b) => a - b);
    const tail = needs.modseq && hits.length ? ` (MODSEQ ${highestHitModseq})` : '';
    this.send(`* SEARCH${hits.length ? ' ' + hits.join(' ') : ''}${tail}`);
    return { s: 'OK', text: 'SEARCH completed', expunge: uidMode };
  }

  private async cmdCopy(c: Command, uidMode: boolean, move: boolean): Promise<Result> {
    const v = this.view!;
    const set = atomArg(c.args[0], 'sequence set');
    const name = decodeMailboxName(astring(c.args[1], 'mailbox'));
    if (move && v.readOnly) return { s: 'NO', code: 'READ-ONLY', text: 'Mailbox is read-only' };
    const dst = await this.ctx.store.getFolder(this.uid, name);
    if (!dst) return { s: 'NO', code: 'TRYCREATE', text: 'No such mailbox' };
    const uids = this.resolveSet(set, uidMode);
    const verb = move ? 'MOVE' : 'COPY';
    if (!uids.length) return { s: 'OK', text: `${verb} completed`, expunge: uidMode || move };
    if (move && dst.id === v.folder.id) return { s: 'NO', code: 'CANNOT', text: 'Source and destination are the same' };
    const r = move ? await this.ctx.store.move(v.folder.id, uids, dst.id) : await this.ctx.store.copy(v.folder.id, uids, dst.id);
    if (!r.map.length) return { s: 'OK', text: `${verb} completed`, expunge: uidMode || move };
    const code = `COPYUID ${r.uidvalidity} ${compressSet(r.map.map((x) => x[0]))} ${compressSet(r.map.map((x) => x[1]))}`;
    if (move) {
      this.send(`* OK [${code}] Moved`);
      return { s: 'OK', text: 'MOVE completed', expunge: true };
    }
    return { s: 'OK', code, text: 'COPY completed', expunge: uidMode };
  }
}
