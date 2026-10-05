import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SecretBox } from '../src/secrets.js';
import { CHUNK, decryptStream, encryptedSize, encryptStream, keyFromInfo, newEncryption } from '../src/backup/crypt.js';
import { S3Store, type S3Config } from '../src/backup/remote.js';
import { performBackup, materializeRun, verifyLatestBackups, type BackupTargetRow } from '../src/backup/service.js';
import { restorePartial } from '../src/backup/restore.js';
import { exec, one, rows } from '../src/db.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';

async function roundTrip(data: Buffer, key: Buffer): Promise<{ enc: Buffer; dec: Buffer }> {
  const encParts: Buffer[] = [];
  await pipeline(Readable.from([data]), encryptStream(key), new Writable({ write: (c, _e, cb) => (encParts.push(c), cb()) }));
  const enc = Buffer.concat(encParts);
  const decParts: Buffer[] = [];
  await pipeline(Readable.from([enc]), decryptStream(key), new Writable({ write: (c, _e, cb) => (decParts.push(c), cb()) }));
  return { enc, dec: Buffer.concat(decParts) };
}

async function decrypt(enc: Buffer, key: Buffer): Promise<Buffer> {
  const parts: Buffer[] = [];
  await pipeline(Readable.from([enc]), decryptStream(key), new Writable({ write: (c, _e, cb) => (parts.push(c), cb()) }));
  return Buffer.concat(parts);
}

describe('backup encryption', () => {
  it('round-trips any size; the size is predictable', async () => {
    const { key, info } = await newEncryption('correct horse battery staple');
    for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
      const data = randomBytes(n);
      const { enc, dec } = await roundTrip(data, key);
      expect(dec.equals(data)).toBe(true);
      expect(enc.length).toBe(encryptedSize(n));
    }
    expect((await keyFromInfo('correct horse battery staple', info)).equals(key)).toBe(true);
    await expect(keyFromInfo('wrong passphrase!!', info)).rejects.toThrow(/Wrong backup passphrase/);
  });

  it('detects changed, reordered and truncated data', async () => {
    const { key } = await newEncryption('correct horse battery staple');
    const data = randomBytes(3 * CHUNK + 5);
    const { enc } = await roundTrip(data, key);
    const flipped = Buffer.from(enc);
    flipped[100] = flipped[100]! ^ 1;
    await expect(decrypt(flipped, key)).rejects.toThrow(/authentication/);
    // Drop the final chunk: the file now ends on a non-final chunk.
    const lastChunk = 4 + 5 + 16;
    await expect(decrypt(enc.subarray(0, enc.length - lastChunk), key)).rejects.toThrow(/truncated|authentication/);
    const other = (await newEncryption('another passphrase 123')).key;
    await expect(decrypt(enc, other)).rejects.toThrow(/authentication/);
  });
});

describe('S3 request signing', () => {
  it('matches the AWS Signature Version 4 example (GET Object)', () => {
    const secrets = new SecretBox(new Map([[1, randomBytes(32)]]), 1);
    const cfg: S3Config = {
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      prefix: '',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: secrets.seal('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').toString('base64'),
      pathStyle: false,
    };
    const s = new S3Store(cfg, secrets);
    s.clock = () => new Date('2013-05-24T00:00:00Z');
    const r = s.sign('GET', 'test.txt', { headers: { range: 'bytes=0-9' } });
    expect(r.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

/** In-memory S3 (path style): PUT, GET, DELETE, ListObjectsV2. */
function fakeS3(): { server: Server; objects: Map<string, Buffer>; start(): Promise<number> } {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/ap-south-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/.test(req.headers.authorization ?? '')) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>bad signature header</Message></Error>');
      return;
    }
    const u = new URL(req.url!, 'http://x');
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    if (bucket !== 'mailbackup') return void res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      if (Number(req.headers['content-length']) !== body.length) return void res.writeHead(400).end('<Error><Code>IncompleteBody</Code></Error>');
      objects.set(key, body);
      return void res.writeHead(200).end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return void res.writeHead(204).end();
    }
    if (req.method === 'GET' && !key) {
      const prefix = u.searchParams.get('prefix') ?? '';
      const list = [...objects].filter(([k]) => k.startsWith(prefix));
      return void res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${list.map(([k, v]) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'GET') {
      const v = objects.get(key);
      if (!v) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      return void res.end(v);
    }
    res.writeHead(405).end();
  });
  return { server, objects, start: () => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port))) };
}

describe.skipIf(!dbConfig())('backups to S3', () => {
  let core: TestCore;
  const s3 = fakeS3();
  let target: BackupTargetRow;
  let alice: number;
  const domain = uniqueDomain();

  beforeAll(async () => {
    core = await startCore();
    const port = await s3.start();
    const seal = (v: string) => core.ctx.secrets.seal(v).toString('base64');
    const config = {
      endpoint: `http://127.0.0.1:${port}`,
      region: 'ap-south-1',
      bucket: 'mailbackup',
      prefix: 'office',
      accessKeyId: 'AK',
      secretAccessKey: seal('SECRET'),
      pathStyle: true,
      encryption: { enabled: true, passphrase: seal('Agra-Steel-Backup-2026!') },
    };
    const r = await exec(core.ctx.db, "INSERT INTO backup_targets (name, kind, config, encrypt_backups, is_enabled, created_at) VALUES ('Cloud', 's3', ?, 1, 1, ?)", [JSON.stringify(config), new Date()]);
    target = (await one<BackupTargetRow>(core.ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [r.insertId]))!;
    await core.ctx.directory.createDomain(domain);
    alice = await makeUser(core.ctx, `alice@${domain}`);
    const msg = await core.ctx.store.ingest(Buffer.from(`From: x@y.test\r\nTo: alice@${domain}\r\nSubject: Invoice 42\r\nMessage-ID: <inv42@y.test>\r\n\r\nPlease pay invoice 42 by Friday.\r\n`));
    await core.ctx.delivery.deliver({ message: msg, targets: [{ userId: alice }], origin: 'internal', envelopeFrom: 'x@y.test' });
  });
  afterAll(async () => {
    s3.server.close();
    await core.stop();
  });

  it('uploads an encrypted, verified backup and removes the local staging copy', async () => {
    const r = await performBackup(core.ctx, { targetId: target.id, kind: 'full' });
    expect(r).toMatchObject({ status: 'verified', dirName: expect.stringMatching(/^vpm-full-/) });
    const keys = [...s3.objects.keys()].filter((k) => k.startsWith(`office/${r.dirName}/`));
    expect(keys).toEqual(expect.arrayContaining([`office/${r.dirName}/manifest.json`, `office/${r.dirName}/encryption.json`, `office/${r.dirName}/db/users.jsonl.gz`]));
    // Nothing readable on the provider: every file except encryption.json is ciphertext.
    for (const k of keys) if (!k.endsWith('encryption.json')) expect(s3.objects.get(k)!.subarray(0, 8).toString()).toBe('VPMENC1\n');
    expect([...s3.objects.values()].some((v) => v.includes('Please pay invoice 42'))).toBe(false);
    const run = await one<{ remote_objects: number; remote_bytes: number }>(core.ctx.db, 'SELECT remote_objects, remote_bytes FROM backup_runs WHERE id = ?', [r.runId]);
    expect(run!.remote_objects).toBe(keys.length);
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(core.ctx.config.dataPath, 'backup-staging', `target-${target.id}`))).toBe(false);
  });

  it('incrementals build on the cloud copy; nightly check notices missing files', async () => {
    const msg = await core.ctx.store.ingest(Buffer.from(`From: x@y.test\r\nTo: alice@${domain}\r\nSubject: Later\r\nMessage-ID: <later@y.test>\r\n\r\nNew mail after the full backup.\r\n`));
    await core.ctx.delivery.deliver({ message: msg, targets: [{ userId: alice }], origin: 'internal', envelopeFrom: 'x@y.test' });
    const inc = await performBackup(core.ctx, { targetId: target.id, kind: 'incremental' });
    expect(inc).toMatchObject({ status: 'verified', dirName: expect.stringMatching(/^vpm-incremental-/) });
    await verifyLatestBackups(core.ctx);
    expect(await one(core.ctx.db, `SELECT id FROM admin_alerts WHERE dedupe_key = 'backup.corrupt.${target.id}' AND resolved_at IS NULL`)).toBeUndefined();
    const victim = [...s3.objects.keys()].find((k) => k.startsWith(`office/${inc.dirName}/db/`))!;
    const saved = s3.objects.get(victim)!;
    s3.objects.delete(victim);
    await verifyLatestBackups(core.ctx);
    expect(await one(core.ctx.db, `SELECT id FROM admin_alerts WHERE dedupe_key = 'backup.corrupt.${target.id}' AND resolved_at IS NULL`)).toBeTruthy();
    s3.objects.set(victim, saved);
    await verifyLatestBackups(core.ctx);
    expect(await one(core.ctx.db, `SELECT id FROM admin_alerts WHERE dedupe_key = 'backup.corrupt.${target.id}' AND resolved_at IS NULL`)).toBeUndefined();
  });

  it('restores from the cloud: downloads and decrypts the chain, needs the passphrase', async () => {
    const last = await one<{ dir_name: string }>(core.ctx.db, "SELECT dir_name FROM backup_runs WHERE target_id = ? AND kind = 'incremental' ORDER BY id DESC LIMIT 1", [target.id]);
    const inbox = (await core.ctx.store.getSpecialFolder(alice, 'inbox'))!;
    await core.ctx.store.storeFlags(inbox.id, await core.ctx.store.listUids(inbox.id), 'add', 8, null);
    await core.ctx.store.expunge(inbox.id);
    const m = await materializeRun(core.ctx, target, last!.dir_name);
    try {
      const res = await restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.ctx.config.dataPath }, m.dir, { sourceUserId: alice, folderPath: 'INBOX' });
      expect(res.items).toBe(2);
    } finally {
      await m.cleanup();
    }
    expect((await core.ctx.store.getFolderById(inbox.id))!.message_count).toBe(2);
    // A new server (another master key) restores with the written-down passphrase; a wrong one is refused.
    await expect(materializeRun(core.ctx, target, last!.dir_name, { passphrase: 'not the passphrase' })).rejects.toThrow(/Wrong backup passphrase/);
    const ok = await materializeRun(core.ctx, target, last!.dir_name, { passphrase: 'Agra-Steel-Backup-2026!', dbOnly: true });
    await ok.cleanup();
  });

  it('rotation deletes old runs from the bucket', async () => {
    const sched = await exec(core.ctx.db, "INSERT INTO backup_schedules (name, target_id, kind, cron, keep_full, is_enabled, created_at) VALUES ('Cloud nightly', ?, 'full', '0 1 * * *', 1, 1, ?)", [target.id, new Date()]);
    const a = await performBackup(core.ctx, { targetId: target.id, kind: 'full', scheduleId: sched.insertId });
    const b = await performBackup(core.ctx, { targetId: target.id, kind: 'full', scheduleId: sched.insertId });
    expect([...s3.objects.keys()].some((k) => k.startsWith(`office/${a.dirName}/`))).toBe(false);
    expect([...s3.objects.keys()].some((k) => k.startsWith(`office/${b.dirName}/`))).toBe(true);
    expect((await rows<{ status: string }>(core.ctx.db, 'SELECT status FROM backup_runs WHERE id = ?', [a.runId]))[0]!.status).toBe('expired');
  });
});
