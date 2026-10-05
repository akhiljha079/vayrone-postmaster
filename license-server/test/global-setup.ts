// Reuses the product's throwaway MySQL (core/test/global-setup.ts) and creates
// a separate vls_test database for the License Server.
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import type { TestProject } from 'vitest/node';
import coreSetup from '../../core/test/global-setup.js';
import type { LsConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    lsdb: LsConfig['db'] | null;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let core: { socketPath?: string; host?: string; port?: number; user: string; password?: string } | null = null;
  const teardown = await coreSetup({
    // The product database (vpm_test) is used by the end-to-end tests with LicenseManager.
    provide: (key: string, value: unknown) => {
      if (key === 'db') core = value as typeof core;
      project.provide(key as 'lsdb', value as never);
    },
  } as unknown as TestProject);
  if (!core) {
    project.provide('lsdb', null);
    return teardown;
  }
  const { socketPath, host, port, user, password } = core as NonNullable<typeof core>;
  const server = { socketPath, host, port, user, password };
  const admin = await mysql.createConnection(server);
  await admin.query('DROP DATABASE IF EXISTS vls_test');
  await admin.query('CREATE DATABASE vls_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.end();
  const cfg = { ...server, database: 'vls_test' };
  await migrate(cfg, join(resolve(import.meta.dirname, '..'), 'db'));
  project.provide('lsdb', cfg);
  return teardown;
}
