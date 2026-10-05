// Production wiring: a CoreContext whose licence gate is a LicenseManager.
// The database must be migrated first (license_state lives there).
import { createContext, type CoreConfig, type CoreContext } from '@vpm/core';
import { LicenseManager, type LicenseManagerOptions } from './manager.js';

export async function createLicensedContext(config: CoreConfig, opts: { log?: CoreContext['log']; manager?: LicenseManagerOptions } = {}): Promise<{ ctx: CoreContext; license: LicenseManager }> {
  let manager: LicenseManager | null = null;
  const ctx = await createContext(config, {
    ...(opts.log ? { log: opts.log } : {}),
    licenseFactory: async (d) => (manager = await LicenseManager.open(d, opts.manager)),
  });
  const license = manager as unknown as LicenseManager;
  license.start();
  return { ctx, license };
}
