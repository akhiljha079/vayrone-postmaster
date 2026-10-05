import { pino, type Logger } from 'pino';
import type { CoreConfig } from './config.js';
import { createPool, type Db } from './db.js';
import { BlobStore } from './store/blobstore.js';
import { MailStore } from './store/mailstore.js';
import { MailEvents } from './events.js';
import { Directory } from './directory.js';
import { Delivery } from './delivery.js';
import { loadTls, type TlsMaterial } from './tls.js';
import { Settings } from './settings.js';
import { IpPolicy } from './ippolicy.js';
import { AuditLog } from './audit.js';
import { loadSecretBox, type SecretBox } from './secrets.js';
import { UNLIMITED_LICENSE, type LicenseGate } from './license-gate.js';
import { MailFlow } from './mailflow.js';
import { Archiver } from './archive/archive.js';
import { ConnectionLimiter, DEFAULT_LIMITS } from './connlimit.js';

export interface CoreContext {
  config: CoreConfig;
  db: Db;
  blobs: BlobStore;
  store: MailStore;
  events: MailEvents;
  directory: Directory;
  delivery: Delivery;
  mailflow: MailFlow;
  archiver: Archiver;
  tls: TlsMaterial;
  settings: Settings;
  ipPolicy: IpPolicy;
  audit: AuditLog;
  secrets: SecretBox;
  license: LicenseGate;
  connections: ConnectionLimiter;
  log: Logger;
}

export interface ContextOptions {
  log?: Logger;
  license?: LicenseGate;
  /** Builds the licence gate once the DB and master key are available (production). */
  licenseFactory?: (deps: { db: Db; secrets: SecretBox; config: CoreConfig; log: Logger }) => Promise<LicenseGate>;
}

export async function createContext(config: CoreConfig, opts: ContextOptions | Logger = {}): Promise<CoreContext> {
  const o: ContextOptions = 'info' in opts && typeof (opts as Logger).info === 'function' ? { log: opts as Logger } : (opts as ContextOptions);
  const logger = o.log ?? pino({ level: config.logLevel, base: { svc: 'vpm' } });
  const db = createPool(config.db);
  const blobs = new BlobStore(config.dataPath, config.storeCodec);
  await blobs.init();
  const events = new MailEvents();
  const store = new MailStore(db, blobs, events);
  const settings = new Settings(db);
  const ipPolicy = new IpPolicy(db);
  const secrets = await loadSecretBox(config, (m) => logger.warn(m));
  const license = o.licenseFactory ? await o.licenseFactory({ db, secrets, config, log: logger }) : (o.license ?? UNLIMITED_LICENSE);
  const directory = new Directory(db, store, { settings, ipPolicy, license });
  const delivery = new Delivery(db, store, config.dedupWindowHours);
  const tls = await loadTls(config);
  const mailflow = new MailFlow(db, store, delivery, directory, settings, config, logger);
  const archiver = new Archiver(db, settings, license);
  mailflow.archiver = archiver;
  return {
    config,
    db,
    blobs,
    store,
    events,
    directory,
    delivery,
    mailflow,
    archiver,
    tls,
    settings,
    ipPolicy,
    audit: new AuditLog(db),
    secrets,
    license,
    connections: new ConnectionLimiter({ ...DEFAULT_LIMITS, ...config.limits }),
    log: logger,
  };
}
