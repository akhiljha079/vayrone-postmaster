import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface DbConfig {
  host?: string;
  port?: number;
  socketPath?: string;
  user: string;
  password?: string;
  database: string;
  connectionLimit?: number;
}

export interface CoreConfig {
  /** Name this server announces in SMTP banners, Received headers and IMAP greetings. */
  hostname: string;
  /** Unique per installation; used in X-VPM-Loop and internal IDs. */
  installId: string;
  dataPath: string;
  migrationsPath: string;
  db: DbConfig;
  listenHost: string;
  /** 0 disables a listener. */
  ports: {
    submission: number; // 587, STARTTLS
    smtps: number; // 465, implicit TLS
    imap: number; // 143, STARTTLS
    imaps: number; // 993
    pop3: number; // 110, STLS
    pop3s: number; // 995
  };
  tls: { certFile?: string; keyFile?: string };
  /** LAN default: allow AUTH/LOGIN without TLS. Turn off to require STARTTLS. */
  allowPlaintextAuth: boolean;
  maxMessageSize: number;
  dedupWindowHours: number;
  /** Message blob compression. zstd is used only when the runtime supports it. */
  storeCodec: 'zstd' | 'gzip' | 'none';
  logLevel: string;
  /** Hex master key file (Linux, root:vpm 0440). */
  masterKeyFile?: string;
  /** DPAPI-protected master key blob (Windows). */
  masterKeyDpapiFile?: string;
  /** Web admin / webmail listener (HTTPS unless tls is false). */
  /** httpPort: plain-HTTP port that only redirects to the HTTPS admin panel (0 = off), so typing "localhost" works. */
  web: { port: number; tls: boolean; trustProxy: boolean; httpPort: number };
  /** Directory with the built web SPA (web/dist). */
  webRoot?: string;
  worker: { pollMs: number; fetchConcurrency: number; fetchPerHost: number; fetchMaxPerRun: number };
  /** Loopback channel other processes use to tell core about mailbox changes (0 = off). */
  ipc: { port: number };
  /** Vayrone License Server (online activation and heartbeat). */
  license?: { serverUrl?: string };
  /** Optional Redis/Valkey for large sites (events between processes, instant job wake-up). */
  redis?: { url: string };
  /** Mail protocol connection limits (defaults: 5000 total, 300 per address). */
  limits?: { maxConnections?: number; maxPerIp?: number };
}

export const DEFAULT_CONFIG: Omit<CoreConfig, 'installId' | 'db'> = {
  hostname: 'postmaster.local',
  dataPath: './data',
  migrationsPath: './db',
  listenHost: '0.0.0.0',
  ports: { submission: 587, smtps: 465, imap: 143, imaps: 993, pop3: 110, pop3s: 995 },
  tls: {},
  allowPlaintextAuth: true,
  maxMessageSize: 50 * 1024 * 1024,
  dedupWindowHours: 72,
  storeCodec: 'zstd',
  logLevel: 'info',
  web: { port: 443, tls: true, trustProxy: false, httpPort: 80 },
  worker: { pollMs: 2000, fetchConcurrency: 50, fetchPerHost: 8, fetchMaxPerRun: 200 },
  ipc: { port: 7725 },
};

export type ConfigInput = Partial<Omit<CoreConfig, 'ports' | 'tls' | 'web' | 'worker' | 'ipc'>> & {
  ipc?: Partial<CoreConfig['ipc']>;
  ports?: Partial<CoreConfig['ports']>;
  tls?: CoreConfig['tls'];
  web?: Partial<CoreConfig['web']>;
  worker?: Partial<CoreConfig['worker']>;
  db: DbConfig;
};

export function buildConfig(input: ConfigInput): CoreConfig {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    installId: input.installId ?? randomBytes(8).toString('hex'),
    ports: { ...DEFAULT_CONFIG.ports, ...input.ports },
    tls: { ...DEFAULT_CONFIG.tls, ...input.tls },
    web: { ...DEFAULT_CONFIG.web, ...input.web },
    worker: { ...DEFAULT_CONFIG.worker, ...input.worker },
    ipc: { ...DEFAULT_CONFIG.ipc, ...input.ipc },
    dataPath: resolve(input.dataPath ?? DEFAULT_CONFIG.dataPath),
    migrationsPath: resolve(input.migrationsPath ?? DEFAULT_CONFIG.migrationsPath),
  };
}

/**
 * Settings the setup wizard and admin panel may change at runtime (network,
 * TLS). They live in <dataPath>/runtime.json because the main config file is
 * owned by root / Administrators and is read-only for the service account.
 */
export interface RuntimeOverrides {
  hostname?: string;
  listenHost?: string;
  ports?: Partial<CoreConfig['ports']>;
  web?: { port?: number };
  tls?: { certFile?: string; keyFile?: string };
}

export const RUNTIME_FILE = 'runtime.json';

export function readRuntimeOverrides(dataPath: string): RuntimeOverrides {
  const file = join(dataPath, RUNTIME_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeOverrides;
  } catch {
    return {};
  }
}

export function writeRuntimeOverrides(dataPath: string, patch: RuntimeOverrides): RuntimeOverrides {
  const cur = readRuntimeOverrides(dataPath);
  const next: RuntimeOverrides = {
    ...cur,
    ...patch,
    ports: { ...cur.ports, ...patch.ports },
    web: { ...cur.web, ...patch.web },
    tls: patch.tls !== undefined ? patch.tls : cur.tls,
  };
  mkdirSync(dataPath, { recursive: true });
  const file = join(dataPath, RUNTIME_FILE);
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o640 });
  renameSync(`${file}.tmp`, file);
  return next;
}

export function applyRuntimeOverrides(cfg: CoreConfig, o: RuntimeOverrides = readRuntimeOverrides(cfg.dataPath)): CoreConfig {
  return {
    ...cfg,
    ...(o.hostname ? { hostname: o.hostname } : {}),
    ...(o.listenHost ? { listenHost: o.listenHost } : {}),
    ports: { ...cfg.ports, ...o.ports },
    web: { ...cfg.web, ...(o.web?.port ? { port: o.web.port } : {}) },
    tls: o.tls?.certFile && o.tls.keyFile ? { certFile: o.tls.certFile, keyFile: o.tls.keyFile } : o.tls ? {} : cfg.tls,
  };
}

/** Loads VPM_CONFIG (default ./vpm.config.json), then the runtime overrides from the data path. */
export function loadConfig(path = process.env.VPM_CONFIG ?? 'vpm.config.json'): CoreConfig {
  if (!existsSync(path)) throw new Error(`Config file not found: ${resolve(path)}`);
  const input = JSON.parse(readFileSync(path, 'utf8')) as ConfigInput;
  if (!input.db?.database) throw new Error('Config: db.database is required');
  if (!input.installId) throw new Error('Config: installId is required (generated by the installer)');
  return applyRuntimeOverrides(buildConfig(input));
}
