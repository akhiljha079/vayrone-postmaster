// Server-only access to the License Server. The "server-only" import makes the
// Next.js build fail if this file is ever pulled into browser code.
import 'server-only';
import { createVlsClient } from './vayrone-license';

const baseUrl = process.env.VLS_URL;
const apiKey = process.env.VLS_API_KEY;

export function vls() {
  if (!baseUrl || !apiKey) throw new Error('Set VLS_URL and VLS_API_KEY in the website server environment (.env.local)');
  return createVlsClient({ baseUrl, apiKey });
}
