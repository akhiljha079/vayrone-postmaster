// Machine fingerprint: five hardware/OS identifiers, each hashed separately so
// a licence tolerates one replaced part (a new disk, a BIOS update that resets
// a serial) without re-activation.
//
//   os    Linux /etc/machine-id · Windows MachineGuid (OS install id)
//   board baseboard serial (falls back to the BIOS / system serial)
//   uuid  SMBIOS system UUID
//   disk  serial of the disk holding the data directory (else the first disk)
//   cpu   CPU identification (vendor, model, family/stepping, core count)
//
// Linux exposes the DMI serials to root only. The service unit (Phase 9) runs
// `vpm hwid --write /run/vayrone-postmaster/hwid` as root before start;
// collect() reads that file for any value it cannot read directly.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { COMPONENTS, type ComponentName, type Components } from './format.js';

const run = promisify(execFile);

export type RawComponents = Record<ComponentName, string | null>;

export interface Fingerprint {
  /** Display id, e.g. 7F3KQ-2M9XA-0PWE4-HH51C. */
  machineId: string;
  components: Components;
  /** Which components could be read (no values). */
  available: ComponentName[];
}

export const HWID_FILE = '/run/vayrone-postmaster/hwid';

const PLACEHOLDERS = [
  /^$/,
  /^(none|null|n\/?a|na|unknown|not specified|not applicable|default string|to be filled by o\.?e\.?m\.?|system serial number|chassis serial number|base board serial number|serial|0+|f+|x+|123456789|invalid)$/i,
  /^0{8}-0{4}-0{4}-0{4}-0{12}$/,
  /^f{8}-f{4}-f{4}-f{4}-f{12}$/i,
  /^03000200-0400-0500-0006-000700080009$/i, // a common placeholder UUID on cheap boards
];

export function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/\0/g, '').trim();
  return PLACEHOLDERS.some((p) => p.test(s)) ? null : s;
}

export function hashComponent(name: ComponentName, value: string | null): string | null {
  const v = clean(value);
  if (v === null) return null;
  return createHash('sha256').update(`vpm-fp/1|${name}|${v.toLowerCase()}`).digest('hex').slice(0, 32);
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function machineIdOf(c: Components): string {
  const h = createHash('sha256')
    .update(COMPONENTS.map((n) => `${n}=${c[n] ?? '-'}`).join(';'))
    .digest();
  const chars = [...h.subarray(0, 20)].map((b) => B32[b & 31]).join('');
  return chars.match(/.{5}/g)!.join('-');
}

export function fingerprintOf(raw: RawComponents): Fingerprint {
  const components = Object.fromEntries(COMPONENTS.map((n) => [n, hashComponent(n, raw[n])])) as Components;
  return { machineId: machineIdOf(components), components, available: COMPONENTS.filter((n) => components[n] !== null) };
}

export interface MatchResult {
  ok: boolean;
  matched: ComponentName[];
  changed: ComponentName[];
}

/**
 * The licence stays valid while at most one licensed component changed and at
 * least three still match (fewer when the machine exposed fewer at activation).
 */
export function matchFingerprint(licensed: Components, current: Components): MatchResult {
  const present = COMPONENTS.filter((n) => licensed[n]);
  const matched = present.filter((n) => current[n] === licensed[n]);
  const changed = present.filter((n) => current[n] !== licensed[n]);
  const need = Math.min(3, present.length);
  return { ok: present.length > 0 && changed.length <= 1 && matched.length >= need, matched, changed };
}

// ---------------------------------------------------------------- collection

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

async function sh(cmd: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

function cpuSignature(extra = ''): string | null {
  const list = cpus();
  if (!list.length) return null;
  return `${list[0]!.model.replace(/\s+/g, ' ').trim()}|${extra}|${list.length}`;
}

/** Disk serial on Linux from /dev/disk/by-id (world-readable symlinks). */
function linuxDiskSerial(dataPath: string): string | null {
  const dir = '/dev/disk/by-id';
  if (!existsSync(dir)) return null;
  let wantDev: string | null = null;
  try {
    // Block device holding the data directory (longest matching mount point).
    const st = readFileSync('/proc/self/mountinfo', 'utf8');
    const real = realpathSync(dataPath);
    let best = '';
    for (const line of st.split('\n')) {
      const f = line.split(' ');
      const mnt = f[4];
      const src = f[f.indexOf('-') + 2];
      if (mnt && src?.startsWith('/dev/') && (real === mnt || real.startsWith(mnt.endsWith('/') ? mnt : `${mnt}/`)) && mnt.length > best.length) {
        best = mnt;
        wantDev = realpathSync(src).replace(/^\/dev\//, '');
      }
    }
  } catch {
    /* fall through to the first disk */
  }
  const parent = (dev: string) => {
    try {
      const p = realpathSync(`/sys/class/block/${dev}`);
      return existsSync(`${p}/partition`) ? basename(dirname(p)) : dev;
    } catch {
      return dev;
    }
  };
  const entries = readdirSync(dir)
    .filter((n) => /^(ata|nvme|scsi|usb|wwn|virtio|mmc)-/.test(n) && !/-part\d+$/.test(n) && !/^nvme-eui|^nvme-nvme|^wwn-/.test(n))
    .map((n) => {
      try {
        return { name: n, dev: realpathSync(`${dir}/${n}`).replace(/^\/dev\//, '') };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; dev: string } => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const hit = (wantDev && entries.find((e) => e.dev === parent(wantDev!))) ?? entries[0];
  return hit ? hit.name.replace(/^[a-z]+-/, '') : null;
}

async function collectLinux(dataPath: string): Promise<RawComponents> {
  const dmi = (f: string) => readText(`/sys/class/dmi/id/${f}`);
  const cpuinfo = readText('/proc/cpuinfo') ?? '';
  const field = (k: string) => new RegExp(`^${k}\\s*:\\s*(.+)$`, 'm').exec(cpuinfo)?.[1]?.trim() ?? '';
  const raw: RawComponents = {
    os: readText('/etc/machine-id') ?? readText('/var/lib/dbus/machine-id'),
    board: clean(dmi('board_serial')) ?? clean(dmi('product_serial')),
    uuid: dmi('product_uuid'),
    disk: linuxDiskSerial(dataPath),
    cpu: cpuSignature(`${field('vendor_id')}/${field('cpu family')}/${field('model')}/${field('stepping')}`),
  };
  // Root-only DMI values come from the pre-start helper when we cannot read them.
  const helper = readText(process.env.VPM_HWID_FILE ?? HWID_FILE);
  if (helper) {
    try {
      const h = JSON.parse(helper) as Partial<RawComponents>;
      for (const n of COMPONENTS) if (!clean(raw[n]) && h[n]) raw[n] = h[n]!;
    } catch {
      /* ignore a damaged helper file */
    }
  }
  return raw;
}

async function collectWindows(dataPath: string): Promise<RawComponents> {
  const drive = /^[a-z]:/i.exec(dataPath)?.[0]?.toUpperCase() ?? 'C:';
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$cs = Get-CimInstance Win32_ComputerSystemProduct',
    '$bb = Get-CimInstance Win32_BaseBoard',
    '$bios = Get-CimInstance Win32_BIOS',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
    `$part = Get-Partition -DriveLetter '${drive[0]}'`,
    '$disk = if ($part) { Get-Disk -Number $part.DiskNumber } else { Get-Disk | Sort-Object Number | Select-Object -First 1 }',
    "$guid = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid",
    '[pscustomobject]@{ os=$guid; board=$bb.SerialNumber; bios=$bios.SerialNumber; uuid=$cs.UUID; disk=$disk.SerialNumber; cpu=("{0}|{1}|{2}" -f $cpu.Name,$cpu.ProcessorId,$cpu.NumberOfCores) } | ConvertTo-Json -Compress',
  ].join('; ');
  const out = await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30_000);
  let j: Record<string, string | null> = {};
  try {
    j = JSON.parse(out.trim() || '{}') as Record<string, string | null>;
  } catch {
    /* empty */
  }
  return { os: j.os ?? null, board: clean(j.board) ?? clean(j.bios), uuid: j.uuid ?? null, disk: j.disk ?? null, cpu: j.cpu ?? cpuSignature() };
}

async function collectMac(): Promise<RawComponents> {
  // Development machines only; the product is supported on Windows and Linux.
  const io = await sh('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const get = (k: string) => new RegExp(`"${k}" = "([^"]+)"`).exec(io)?.[1] ?? null;
  return { os: get('IOPlatformUUID'), board: get('IOPlatformSerialNumber'), uuid: get('IOPlatformUUID') ? `hw:${get('IOPlatformUUID')}` : null, disk: null, cpu: cpuSignature() };
}

export async function collectRaw(dataPath: string): Promise<RawComponents> {
  switch (platform()) {
    case 'linux':
      return collectLinux(dataPath);
    case 'win32':
      return collectWindows(dataPath);
    case 'darwin':
      return collectMac();
    default:
      return { os: null, board: null, uuid: null, disk: null, cpu: cpuSignature() };
  }
}

export async function collectFingerprint(dataPath: string): Promise<Fingerprint> {
  return fingerprintOf(await collectRaw(dataPath));
}

/** For the root pre-start helper: raw values for the components only root can read. */
export async function privilegedHwid(dataPath: string): Promise<string> {
  const r = await collectRaw(dataPath);
  return JSON.stringify({ board: r.board, uuid: r.uuid });
}
