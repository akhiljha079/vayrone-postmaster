// Cloud backup targets: S3-compatible object storage (AWS S3, Wasabi,
// Backblaze B2, Cloudflare R2, MinIO, …) and FTP/FTPS servers.
// Backups are written to a local staging folder, verified, then uploaded file
// by file (optionally encrypted, see crypt.ts) and the staging copy removed.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { dirname, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, type Readable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import type { SecretBox } from '../secrets.js';

export interface S3Config {
  endpoint: string; // https://s3.ap-south-1.amazonaws.com
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string | null; // sealed (base64)
  pathStyle: boolean;
}

export interface FtpConfig {
  host: string;
  port: number;
  secure: 'none' | 'explicit' | 'implicit';
  user: string;
  password: string | null; // sealed (base64)
  path: string;
  tlsVerify: boolean;
}

export interface RemoteObject {
  key: string;
  size: number;
}

export interface RemoteStore {
  readonly label: string;
  put(key: string, body: Readable, size: number): Promise<void>;
  getTo(key: string, file: string, transform?: () => NodeJS.ReadWriteStream): Promise<void>;
  list(prefix: string): Promise<RemoteObject[]>;
  remove(keys: string[]): Promise<void>;
  close(): Promise<void>;
}

const unseal = (secrets: SecretBox, v: string | null) => (v ? secrets.open(Buffer.from(v, 'base64')) : '');

// ---------------------------------------------------------------- S3 (SigV4)

const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();
const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class S3Store implements RemoteStore {
  readonly label: string;
  private readonly url: URL;
  private readonly secret: string;
  /** Test hook (AWS signature test vectors). */
  clock: () => Date = () => new Date();

  constructor(
    private readonly c: S3Config,
    secrets: SecretBox,
  ) {
    this.url = new URL(c.endpoint);
    this.secret = unseal(secrets, c.secretAccessKey);
    this.label = `s3://${c.bucket}/${c.prefix}`;
  }

  private host(): string {
    return this.c.pathStyle ? this.url.host : `${this.c.bucket}.${this.url.host}`;
  }

  private path(key: string): string {
    const k = key.split('/').map(enc).join('/');
    return this.c.pathStyle ? `/${enc(this.c.bucket)}/${k}` : `/${k}`;
  }

  private fullKey(key: string): string {
    return posix.join(this.c.prefix.replace(/^\/+/, ''), key);
  }

  /** SigV4 Authorization header and the headers it covers. */
  sign(method: string, key: string, opts: { query?: Record<string, string>; body?: Readable | Buffer; size?: number; headers?: Record<string, string> } = {}): { path: string; query: string; headers: Record<string, string> } {
    const now = this.clock();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const path = this.path(key);
    const query = Object.entries(opts.query ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&');
    const payloadHash = Buffer.isBuffer(opts.body) ? sha256hex(opts.body) : opts.body ? 'UNSIGNED-PAYLOAD' : sha256hex('');
    const headers: Record<string, string> = { host: this.host(), 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...(opts.headers ?? {}) };
    if (opts.size !== undefined) headers['content-length'] = String(opts.size);
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonical = [method, path, query, ...names.map((h) => `${h}:${String(headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}`), '', names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${this.c.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.secret}`, date), this.c.region), 's3'), 'aws4_request');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(kSigning, toSign).toString('hex')}`;
    return { path, query, headers };
  }

  private async send(method: string, key: string, opts: { query?: Record<string, string>; body?: Readable | Buffer; size?: number; headers?: Record<string, string> } = {}): Promise<IncomingMessage> {
    const { path, query, headers } = this.sign(method, key, opts);
    const req = (this.url.protocol === 'http:' ? httpRequest : httpsRequest)({
      method,
      host: this.c.pathStyle ? this.url.hostname : `${this.c.bucket}.${this.url.hostname}`,
      port: this.url.port || undefined,
      path: query ? `${path}?${query}` : path,
      headers,
      timeout: 120_000,
    });
    return new Promise((ok, fail) => {
      req.on('response', ok);
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('S3 request timed out')));
      if (opts.body && !Buffer.isBuffer(opts.body)) opts.body.on('error', (e) => req.destroy(e)).pipe(req);
      else req.end(opts.body);
    });
  }

  private async expect(res: IncomingMessage, what: string, ok = [200, 204]): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!ok.includes(res.statusCode ?? 0)) {
      const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
      const msg = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
      throw new Error(`S3 ${what} failed: HTTP ${res.statusCode}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`);
    }
    return body;
  }

  async put(key: string, body: Readable, size: number): Promise<void> {
    if (size > 5 * 1024 ** 3) throw new Error(`${key} is larger than 5 GB (S3 single upload limit)`);
    await this.expect(await this.send('PUT', this.fullKey(key), { body, size }), `upload of ${key}`);
  }

  async getTo(key: string, file: string, transform?: () => NodeJS.ReadWriteStream): Promise<void> {
    const res = await this.send('GET', this.fullKey(key));
    if (res.statusCode !== 200) await this.expect(res, `download of ${key}`);
    await mkdir(dirname(file), { recursive: true });
    await (transform ? pipeline(res, transform(), createWriteStream(file)) : pipeline(res, createWriteStream(file)));
  }

  async list(prefix: string): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    const base = this.fullKey(prefix);
    const strip = this.c.prefix.replace(/^\/+/, '').replace(/\/?$/, '/');
    let token: string | null = null;
    do {
      const body = await this.expect(await this.send('GET', '', { query: { 'list-type': '2', prefix: base, ...(token ? { 'continuation-token': token } : {}) } }), 'listing');
      for (const m of body.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
        const k = m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        out.push({ key: strip !== '/' && k.startsWith(strip) ? k.slice(strip.length) : k, size: Number(m[2]) });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(body) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)?.[1] ?? null) : null;
    } while (token);
    return out;
  }

  async remove(keys: string[]): Promise<void> {
    for (const k of keys) await this.expect(await this.send('DELETE', this.fullKey(k)), `delete of ${k}`, [200, 204, 404]);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------- FTP / FTPS

class FtpStore implements RemoteStore {
  readonly label: string;
  private client = new FtpClient(60_000);
  private ready: Promise<void> | null = null;
  private madeDirs = new Set<string>();

  constructor(
    private readonly c: FtpConfig,
    private readonly secrets: SecretBox,
  ) {
    this.label = `ftp${c.secure === 'none' ? '' : 's'}://${c.host}${c.path}`;
  }

  private connect(): Promise<void> {
    this.ready ??= (async () => {
      await this.client.access({
        host: this.c.host,
        port: this.c.port,
        user: this.c.user,
        password: unseal(this.secrets, this.c.password),
        secure: this.c.secure === 'none' ? false : this.c.secure === 'implicit' ? 'implicit' : true,
        secureOptions: { rejectUnauthorized: this.c.tlsVerify },
      });
    })();
    return this.ready;
  }

  private abs(key: string): string {
    return posix.join(this.c.path || '/', key);
  }

  async put(key: string, body: Readable, _size: number): Promise<void> {
    await this.connect();
    const dir = posix.dirname(this.abs(key));
    if (!this.madeDirs.has(dir)) {
      await this.client.ensureDir(dir);
      this.madeDirs.add(dir);
    }
    await this.client.uploadFrom(body, this.abs(key));
  }

  async getTo(key: string, file: string, transform?: () => NodeJS.ReadWriteStream): Promise<void> {
    await this.connect();
    await mkdir(dirname(file), { recursive: true });
    if (!transform) {
      await this.client.downloadTo(file, this.abs(key));
      return;
    }
    const pass = new PassThrough();
    const done = pipeline(pass, transform(), createWriteStream(file));
    await this.client.downloadTo(pass, this.abs(key));
    await done;
  }

  async list(prefix: string): Promise<RemoteObject[]> {
    await this.connect();
    const out: RemoteObject[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await this.client.list(this.abs(rel));
      } catch {
        return; // missing folder = nothing there
      }
      for (const e of entries) {
        const r = posix.join(rel, e.name);
        if (e.isDirectory) await walk(r);
        else out.push({ key: r, size: e.size });
      }
    };
    await walk(prefix.replace(/\/$/, ''));
    return out;
  }

  async remove(keys: string[]): Promise<void> {
    await this.connect();
    const dirs = new Set<string>();
    for (const k of keys) {
      await this.client.remove(this.abs(k), true);
      dirs.add(posix.dirname(this.abs(k)));
    }
    // Remove emptied folders, deepest first.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await this.client.removeEmptyDir(d).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

export function isRemoteKind(kind: string): kind is 's3' | 'ftp' {
  return kind === 's3' || kind === 'ftp';
}

export function openRemote(kind: 's3' | 'ftp', config: unknown, secrets: SecretBox): RemoteStore {
  return kind === 's3' ? new S3Store(config as S3Config, secrets) : new FtpStore(config as FtpConfig, secrets);
}

export async function fileSize(f: string): Promise<number> {
  return (await stat(f)).size;
}

export { createReadStream };
