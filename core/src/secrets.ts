// AES-256-GCM envelopes for credentials stored in the DB (external mailbox
// passwords, relay passwords, TOTP seeds, backup target secrets).
//
//   envelope = [key_version:1][iv:12][tag:16][ciphertext]
//
// The master key never touches the DB:
//   * Linux:   a root:vpm 0440 key file (default /etc/vayrone-postmaster/master.key)
//   * Windows: a DPAPI (LocalMachine) protected blob, unwrapped at service start
//   * dev/test: <dataPath>/master.key, created on first use
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY_LEN = 32;

export class SecretBox {
  constructor(
    private readonly keys: Map<number, Buffer>,
    private readonly current: number,
  ) {
    for (const k of keys.values()) if (k.length !== KEY_LEN) throw new Error('Master key must be 32 bytes');
    if (!keys.has(current)) throw new Error('Current key version missing');
  }

  seal(plain: string): Buffer {
    const key = this.keys.get(this.current)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([this.current]), iv, c.getAuthTag(), ct]);
  }

  open(blob: Buffer): string {
    if (blob.length < 29) throw new Error('Secret envelope too short');
    const key = this.keys.get(blob[0]!);
    if (!key) throw new Error(`Unknown secret key version ${blob[0]}`);
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
    d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8');
  }

  /** True when the envelope was sealed with an older key and should be re-sealed. */
  needsRotation(blob: Buffer): boolean {
    return blob[0] !== this.current;
  }
}

export interface MasterKeyConfig {
  /** Hex key file (Linux). */
  masterKeyFile?: string;
  /** DPAPI-protected key blob (Windows). */
  masterKeyDpapiFile?: string;
  dataPath: string;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function dpapi(op: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> {
  const script =
    'Add-Type -AssemblyName System.Security; ' +
    `$b = [Convert]::FromBase64String(${psQuote(data.toString('base64'))}); ` +
    `$r = [Security.Cryptography.ProtectedData]::${op}($b, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine); ` +
    '[Convert]::ToBase64String($r)';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return Buffer.from(stdout.trim(), 'base64');
}

function parseKeyFile(text: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Master key file must contain 64 hex characters');
  return Buffer.from(hex, 'hex');
}

/** Creates a new master key at the configured location (installer / `vpm cli keygen`). */
export async function createMasterKey(cfg: MasterKeyConfig): Promise<string> {
  const key = randomBytes(KEY_LEN);
  if (cfg.masterKeyDpapiFile) {
    if (existsSync(cfg.masterKeyDpapiFile)) throw new Error(`${cfg.masterKeyDpapiFile} already exists`);
    await mkdir(dirname(cfg.masterKeyDpapiFile), { recursive: true });
    await writeFile(cfg.masterKeyDpapiFile, await dpapi('Protect', key));
    return cfg.masterKeyDpapiFile;
  }
  const file = cfg.masterKeyFile ?? join(cfg.dataPath, 'master.key');
  await mkdir(dirname(file), { recursive: true });
  try {
    // 'wx' = exclusive create: concurrent starters (core, web, worker) can never end up with different keys.
    await writeFile(file, key.toString('hex') + '\n', { mode: 0o440, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} already exists`);
    throw e;
  }
  return file;
}

export async function loadSecretBox(cfg: MasterKeyConfig, warn: (m: string) => void = () => {}): Promise<SecretBox> {
  let key: Buffer;
  if (cfg.masterKeyDpapiFile) {
    key = await dpapi('Unprotect', await readFile(cfg.masterKeyDpapiFile));
  } else if (cfg.masterKeyFile) {
    if (process.platform !== 'win32' && (statSync(cfg.masterKeyFile).mode & 0o007) !== 0) {
      warn(`Master key ${cfg.masterKeyFile} is readable by other users; run: chmod 0440 ${cfg.masterKeyFile}`);
    }
    key = parseKeyFile(await readFile(cfg.masterKeyFile, 'utf8'));
  } else {
    const file = join(cfg.dataPath, 'master.key');
    if (!existsSync(file)) {
      try {
        await createMasterKey({ ...cfg, masterKeyFile: file });
        warn(`No master key configured; created development key ${file}. Production installs use an OS-protected key.`);
      } catch (e) {
        if (!existsSync(file)) throw e; // another process created it first — use theirs
      }
    }
    // A concurrent creator may still be writing; wait briefly for a complete key.
    let text = await readFile(file, 'utf8');
    for (let i = 0; i < 20 && text.trim().length < 64; i++) {
      await new Promise((r) => setTimeout(r, 25));
      text = await readFile(file, 'utf8');
    }
    key = parseKeyFile(text);
  }
  return new SecretBox(new Map([[1, key]]), 1);
}
