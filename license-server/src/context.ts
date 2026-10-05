import type { LsConfig } from './config.js';
import type { Db } from './db.js';
import type { Signer } from './signer.js';
import type { Licensing } from './services/licensing.js';
import type { Notifier } from './services/notify.js';
import type { Vault } from './crypto.js';

export interface LsContext {
  config: LsConfig;
  db: Db;
  signer: Signer;
  licensing: Licensing;
  notifier: Notifier;
  vault: Vault;
}
