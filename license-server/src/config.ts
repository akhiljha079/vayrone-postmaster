// License Server configuration (LS_CONFIG, default ./license-server.config.json).
// Deployed on Vayrone's VPS behind aaPanel's nginx (TLS terminates there).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LsConfig {
  db: { host?: string; port?: number; socketPath?: string; user: string; password?: string; database: string; connectionLimit?: number };
  listenHost: string;
  port: number;
  /** Trust X-Forwarded-For from the local reverse proxy. */
  trustProxy: boolean;
  /** Public base URL (links in reminder emails). */
  publicUrl: string;
  /** Ed25519 private key (PEM) used to sign licences. Readable by the service user only. */
  signingKeyFile: string;
  signingKeyId: string;
  /** 64 hex characters: AES-256-GCM key for SMTP / WhatsApp credentials in the settings table. */
  secretKeyFile: string;
  /** Built SPA (license-server/web/dist). */
  webRoot?: string;
  migrationsPath: string;
  logLevel: string;
  /** Prefix of public licence ids, e.g. LIC-2026-000123. */
  licenseIdPrefix: string;
  timezone: string;
  /** Allow the Secure cookie flag to be off (local development over http). */
  insecureCookies?: boolean;
}

export const LS_DEFAULTS: Omit<LsConfig, 'db' | 'signingKeyFile' | 'signingKeyId' | 'secretKeyFile'> = {
  listenHost: '127.0.0.1',
  port: 7780,
  trustProxy: true,
  publicUrl: 'https://license.vayrone.com',
  migrationsPath: './db',
  logLevel: 'info',
  licenseIdPrefix: 'LIC',
  timezone: 'Asia/Kolkata',
};

export function buildLsConfig(input: Partial<LsConfig> & Pick<LsConfig, 'db' | 'signingKeyFile' | 'signingKeyId' | 'secretKeyFile'>): LsConfig {
  return { ...LS_DEFAULTS, ...input, migrationsPath: resolve(input.migrationsPath ?? LS_DEFAULTS.migrationsPath) };
}

export function loadLsConfig(path = process.env.LS_CONFIG ?? 'license-server.config.json'): LsConfig {
  if (!existsSync(path)) throw new Error(`Config file not found: ${resolve(path)}`);
  const j = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof buildLsConfig>[0];
  for (const k of ['db', 'signingKeyFile', 'signingKeyId', 'secretKeyFile'] as const) if (!j[k]) throw new Error(`Config: ${k} is required`);
  return buildLsConfig(j);
}
