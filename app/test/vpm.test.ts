import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from '@vpm/core';
import { main } from '../src/vpm.js';
import { defaultConfigPath, installHome } from '../src/paths.js';

describe('vpm executable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VPM_CONFIG;
    delete process.env.VPM_HOME;
  });

  it('finds the install home (db/ and web/ next to app/) and the config file', () => {
    expect(existsSync(join(installHome(), 'db', 'schema.sql'))).toBe(true);
    process.env.VPM_HOME = '/opt/vayrone-postmaster';
    expect(installHome()).toBe('/opt/vayrone-postmaster');
    process.env.VPM_CONFIG = '/tmp/x.json';
    expect(defaultConfigPath()).toBe('/tmp/x.json');
    delete process.env.VPM_CONFIG;
    expect(defaultConfigPath()).toMatch(process.platform === 'win32' ? /ProgramData\\Vayrone PostMaster\\vpm\.config\.json$/ : /(\/etc\/vayrone-postmaster\/|^.*\/)vpm\.config\.json$/);
  });

  it('prints version, usage and random secrets', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void out.push(String(m)));
    await main(['version']);
    await main(['gen-secret', '24']);
    await main(['help']);
    expect(out[0]).toBe(`Vayrone PostMaster ${APP_VERSION} — Vayrone Infratech`);
    expect(out[1]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(out[2]).toContain('Usage: vpm <core|worker|all|cli|init|setup-token|hwid|version>');
    process.exitCode = 0;
    await main(['nonsense']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
