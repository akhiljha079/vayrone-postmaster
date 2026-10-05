import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig } from '../src/config.js';
import { ConnectionLimiter } from '../src/connlimit.js';
import { checkInstallSecurity } from '../src/hardening.js';
import { dbConfig, startCore, type TestCore } from './helpers.js';

describe('connection limiter', () => {
  it('caps per address and in total; releases once', () => {
    const l = new ConnectionLimiter({ maxConnections: 3, maxPerIp: 2 });
    const a1 = l.acquire('10.0.0.1')!;
    const a2 = l.acquire('::ffff:10.0.0.1')!;
    expect(l.acquire('10.0.0.1')).toBeNull();
    const b1 = l.acquire('10.0.0.2')!;
    expect(l.acquire('10.0.0.3')).toBeNull(); // total
    a1();
    a1(); // double release is harmless
    expect(l.size).toBe(2);
    expect(l.acquire('10.0.0.1')).not.toBeNull();
    a2();
    b1();
  });
});

describe.runIf(process.platform !== 'win32')('install security checks', () => {
  it('flags secrets readable by other users', () => {
    const d = mkdtempSync(join(tmpdir(), 'vpm-sec-'));
    const cfgFile = join(d, 'vpm.config.json');
    const key = join(d, 'master.key');
    writeFileSync(cfgFile, '{}');
    writeFileSync(key, 'k');
    chmodSync(d, 0o750);
    chmodSync(cfgFile, 0o640);
    chmodSync(key, 0o440);
    const config = buildConfig({ db: { user: 'u', database: 'd' }, dataPath: d, masterKeyFile: key });
    expect(checkInstallSecurity(config, cfgFile).filter((f) => !f.message.includes('runs as root'))).toEqual([]);
    chmodSync(cfgFile, 0o644);
    chmodSync(key, 0o444);
    chmodSync(d, 0o755);
    const f = checkInstallSecurity(config, cfgFile);
    expect(f.filter((x) => x.severity === 'critical').map((x) => x.message)).toEqual([expect.stringContaining('config file'), expect.stringContaining('master key')]);
    expect(f.some((x) => x.message.includes('mail data folder'))).toBe(true);
  });
});

describe.skipIf(!dbConfig())('protocol connection limits', () => {
  let core: TestCore;
  beforeAll(async () => {
    core = await startCore();
    core.ctx.connections = new ConnectionLimiter({ maxConnections: 100, maxPerIp: 2 });
  });
  afterAll(() => core.stop());

  const open = (port: number) =>
    new Promise<{ sock: net.Socket; greeting: string }>((ok) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('data', (d) => ok({ sock, greeting: d.toString() }));
    });

  it('the third IMAP/POP3 connection from one address is refused, and allowed again after one closes', async () => {
    const a = await open(core.ports.imap!);
    const b = await open(core.ports.pop3!);
    expect(a.greeting).toMatch(/^\* OK/);
    expect(b.greeting).toMatch(/^\+OK/);
    expect((await open(core.ports.imap!)).greeting).toMatch(/^\* BYE Too many connections/);
    expect((await open(core.ports.pop3!)).greeting).toMatch(/^-ERR Too many connections/);
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const c = await open(core.ports.imap!);
    expect(c.greeting).toMatch(/^\* OK/);
    b.sock.destroy();
    c.sock.destroy();
  });
});
