import { describe, expect, it } from 'vitest';
import { ensureServices, parseServiceState } from '../src/watchdog.js';

const query = (state: string) => `SERVICE_NAME: VayronePostMaster\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : ${state}\r\n`;
const qc = (type: string) => `[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: VayronePostMaster\r\n        START_TYPE         : ${type}\r\n`;

describe('watchdog', () => {
  it('reads sc.exe output', () => {
    expect(parseServiceState('x', query('1  STOPPED'), qc('2   AUTO_START'))).toEqual({ name: 'x', exists: true, running: false, automatic: true });
    expect(parseServiceState('x', query('4  RUNNING'), qc('2   AUTO_START  (DELAYED)'))).toMatchObject({ running: true, automatic: true });
    expect(parseServiceState('x', query('2  START_PENDING'), qc('3   DEMAND_START'))).toMatchObject({ running: true, automatic: false });
    expect(parseServiceState('x', '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:', '')).toMatchObject({ exists: false });
  });

  it('does nothing outside Windows', async () => {
    if (process.platform !== 'win32') expect(await ensureServices(() => undefined)).toEqual([]);
  });
});
