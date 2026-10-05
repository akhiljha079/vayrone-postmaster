// Licence signing. The private key never leaves this host: it is read from a
// file only the service user can read, and nothing ever returns it.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { LICENSE_FORMAT, REVOCATION_FORMAT, signDoc, type LicensePayload, type RevocationPayload } from '@vpm/license-client/format';

export class Signer {
  private constructor(
    private readonly key: KeyObject,
    readonly kid: string,
  ) {
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be an Ed25519 private key');
  }

  static fromPem(pem: string, kid: string): Signer {
    return new Signer(createPrivateKey(pem), kid);
  }

  static fromFile(path: string, kid: string, warn: (m: string) => void = console.warn): Signer {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) warn(`${path} is readable by other users; run: chmod 600 ${path}`);
    return Signer.fromPem(readFileSync(path, 'utf8'), kid);
  }

  publicKeyPem(): string {
    return createPublicKey(this.key).export({ type: 'spki', format: 'pem' }).toString();
  }

  license(p: Omit<LicensePayload, 'format' | 'product'>): string {
    return signDoc<LicensePayload>({ format: LICENSE_FORMAT, product: 'postmaster', ...p }, this.key, this.kid);
  }

  revocation(p: Omit<RevocationPayload, 'format'>): string {
    return signDoc<RevocationPayload>({ format: REVOCATION_FORMAT, ...p }, this.key, this.kid);
  }
}
