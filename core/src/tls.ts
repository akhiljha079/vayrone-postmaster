import { createSecureContext, type SecureContext } from 'node:tls';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generate } from 'selfsigned';
import type { CoreConfig } from './config.js';

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
  context: SecureContext;
}

/**
 * Loads the configured certificate, or creates (once) and reuses a
 * self-signed one under <data>/certs. Phase 9 moves certificates into the
 * tls_certificates table with the private key encrypted.
 */
export async function loadTls(cfg: CoreConfig): Promise<TlsMaterial> {
  let key: Buffer;
  let cert: Buffer;
  if (cfg.tls.certFile && cfg.tls.keyFile) {
    key = await readFile(cfg.tls.keyFile);
    cert = await readFile(cfg.tls.certFile);
  } else {
    const dir = join(cfg.dataPath, 'certs');
    const keyPath = join(dir, 'selfsigned.key');
    const certPath = join(dir, 'selfsigned.crt');
    if (existsSync(keyPath) && existsSync(certPath)) {
      key = await readFile(keyPath);
      cert = await readFile(certPath);
    } else {
      await mkdir(dir, { recursive: true });
      const notAfter = new Date();
      notAfter.setFullYear(notAfter.getFullYear() + 10);
      const pems = await generate([{ name: 'commonName', value: cfg.hostname }], {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: notAfter,
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: cfg.hostname }] }],
      });
      key = Buffer.from(pems.private);
      cert = Buffer.from(pems.cert);
      await writeFile(keyPath, key, { mode: 0o600 });
      await writeFile(certPath, cert, { mode: 0o644 });
    }
  }
  return { key, cert, context: createSecureContext({ key, cert, minVersion: 'TLSv1.2' }) };
}

/**
 * (Re)creates the self-signed certificate for the hostname and the server's
 * LAN addresses, so clients connecting by IP see a matching name.
 */
export async function generateSelfSigned(dataPath: string, hostname: string, ips: string[] = []): Promise<{ certFile: string; keyFile: string }> {
  const dir = join(dataPath, 'certs');
  await mkdir(dir, { recursive: true });
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  const names = [...new Set([hostname, 'localhost'])];
  const pems = await generate([{ name: 'commonName', value: hostname }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'subjectAltName', altNames: [...names.map((value) => ({ type: 2 as const, value })), ...[...new Set(['127.0.0.1', ...ips])].filter((ip) => isIP(ip)).map((ip) => ({ type: 7 as const, ip }))] },
    ],
  });
  const keyFile = join(dir, 'selfsigned.key');
  const certFile = join(dir, 'selfsigned.crt');
  await writeFile(keyFile, pems.private, { mode: 0o600 });
  await writeFile(certFile, pems.cert, { mode: 0o644 });
  return { certFile, keyFile };
}

export interface CertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  names: string[];
}

export function describeCert(pem: string | Buffer): CertInfo {
  const x = new X509Certificate(pem);
  return {
    subject: x.subject,
    issuer: x.issuer,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    selfSigned: x.subject === x.issuer,
    names: (x.subjectAltName ?? '').split(/,\s*/).map((n) => n.replace(/^(DNS|IP Address):/, '')).filter(Boolean),
  };
}

/** Validates an uploaded certificate chain + key and stores them. Throws a user-facing Error. */
export async function installCertificate(dataPath: string, certPem: string, keyPem: string): Promise<{ certFile: string; keyFile: string; info: CertInfo }> {
  let x: X509Certificate;
  try {
    x = new X509Certificate(certPem);
  } catch {
    throw new Error('The certificate is not a valid PEM certificate');
  }
  let key;
  try {
    key = createPrivateKey(keyPem);
  } catch {
    throw new Error('The private key is not a valid, unencrypted PEM key');
  }
  if (!x.checkPrivateKey(key)) throw new Error('The private key does not belong to this certificate');
  if (new Date(x.validTo) < new Date()) throw new Error(`The certificate expired on ${new Date(x.validTo).toISOString().slice(0, 10)}`);
  createSecureContext({ cert: certPem, key: keyPem }); // full chain parses
  const dir = join(dataPath, 'certs');
  await mkdir(dir, { recursive: true });
  const keyFile = join(dir, 'server.key');
  const certFile = join(dir, 'server.crt');
  await writeFile(keyFile, keyPem, { mode: 0o600 });
  await writeFile(certFile, certPem, { mode: 0o644 });
  return { certFile, keyFile, info: describeCert(certPem) };
}
