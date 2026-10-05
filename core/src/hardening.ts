// Start-up security checks: files that hold secrets must not be readable by
// other accounts, and the services should not run as root/Administrator.
import { existsSync, statSync } from 'node:fs';
import type { CoreConfig } from './config.js';

export interface SecurityFinding {
  severity: 'warning' | 'critical';
  message: string;
}

export function checkInstallSecurity(config: CoreConfig, configPath: string | null): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  if (process.platform === 'win32') return out; // NTFS ACLs are set by the installer
  const others = (p: string, what: string, mask: number, sev: SecurityFinding['severity']) => {
    if (!existsSync(p)) return;
    const mode = statSync(p).mode & 0o777;
    if (mode & mask) out.push({ severity: sev, message: `${what} ${p} is accessible by other users (mode ${mode.toString(8)}); run: chmod o-rwx ${p}` });
  };
  if (configPath) others(configPath, 'The config file (database password)', 0o007, 'critical');
  if (config.masterKeyFile) others(config.masterKeyFile, 'The master key', 0o007, 'critical');
  others(config.dataPath, 'The mail data folder', 0o007, 'warning');
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    out.push({ severity: 'warning', message: 'A Vayrone PostMaster service runs as root. The packaged services run as the "vpm" account; check the systemd unit.' });
  }
  return out;
}
