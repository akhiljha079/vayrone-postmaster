// Boots a throwaway MySQL for integration tests.
//   * VPM_TEST_DB_SOCKET / VPM_TEST_DB_HOST(+PORT, USER, PASSWORD): use an existing server.
//   * otherwise: start <repo>/.cache/mysql/bin/mysqld on a private socket.
// Integration tests are skipped when no database is available.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.js';
import type { DbConfig } from '../src/config.js';

declare module 'vitest' {
  export interface ProvidedContext {
    db: DbConfig | null;
  }
}

const ROOT = resolve(import.meta.dirname, '..', '..');
const MYSQL = join(ROOT, '.cache', 'mysql');
const DIR = join(ROOT, '.cache', 'mt-test');
let proc: ChildProcess | null = null;

async function waitFor(cfg: DbConfig, ms: number): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const c = await mysql.createConnection({ socketPath: cfg.socketPath, host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
      await c.end();
      return;
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let server: Omit<DbConfig, 'database'> | null = null;
  if (process.env.VPM_TEST_DB_SOCKET || process.env.VPM_TEST_DB_HOST) {
    server = {
      socketPath: process.env.VPM_TEST_DB_SOCKET,
      host: process.env.VPM_TEST_DB_HOST,
      port: process.env.VPM_TEST_DB_PORT ? Number(process.env.VPM_TEST_DB_PORT) : undefined,
      user: process.env.VPM_TEST_DB_USER ?? 'root',
      password: process.env.VPM_TEST_DB_PASSWORD,
    };
  } else if (existsSync(join(MYSQL, 'bin', 'mysqld'))) {
    const data = join(DIR, 'data');
    const sock = join(DIR, 's.sock');
    if (!existsSync(data)) {
      mkdirSync(DIR, { recursive: true });
      const init = spawnSync(join(MYSQL, 'bin', 'mysqld'), ['--no-defaults', '--initialize-insecure', `--datadir=${data}`, `--basedir=${MYSQL}`], { stdio: 'ignore' });
      if (init.status !== 0) throw new Error('mysqld --initialize-insecure failed');
    }
    rmSync(sock, { force: true });
    proc = spawn(
      join(MYSQL, 'bin', 'mysqld'),
      ['--no-defaults', `--datadir=${data}`, `--basedir=${MYSQL}`, '--skip-networking', `--socket=${sock}`, '--mysqlx=OFF', `--log-error=${join(DIR, 'err.log')}`, '--innodb-buffer-pool-size=128M'],
      { stdio: 'ignore' },
    );
    server = { socketPath: sock, user: 'root' };
  }

  if (!server) {
    console.warn('\n[vpm tests] No MySQL available — integration tests will be skipped.\n');
    project.provide('db', null);
    return async () => {};
  }

  const cfg: DbConfig = { ...server, database: 'vpm_test' };
  await waitFor(cfg, 30_000);
  const admin = await mysql.createConnection({ ...server, password: server.password });
  await admin.query('DROP DATABASE IF EXISTS vpm_test');
  await admin.query('CREATE DATABASE vpm_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.end();
  await migrate(cfg, join(ROOT, 'db'));
  project.provide('db', cfg);

  return async () => {
    if (proc) {
      proc.kill('SIGTERM');
      await new Promise((r) => proc!.once('exit', r));
    }
  };
}
