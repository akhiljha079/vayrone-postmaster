// ClamAV (clamd) INSTREAM client. clamd unpacks MIME, archives and Office files itself.
import net from 'node:net';

export interface ClamdConfig {
  host?: string;
  port?: number;
  socket?: string;
  timeoutMs?: number;
}

export type ScanResult = { clean: true } | { clean: false; signature: string };

export function clamScan(data: Buffer, c: ClamdConfig): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = c.socket ? net.connect(c.socket) : net.connect(c.port ?? 3310, c.host ?? '127.0.0.1');
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (e: Error | null, r?: ScanResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      e ? reject(e) : resolve(r!);
    };
    sock.setTimeout(c.timeoutMs ?? 60_000, () => finish(new Error('ClamAV did not answer in time')));
    sock.on('error', (e) => finish(new Error(`ClamAV not reachable: ${e.message}`)));
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      const m = /:\s*(.+) FOUND$/.exec(reply);
      if (m) return finish(null, { clean: false, signature: m[1]! });
      if (/:\s*OK$/.test(reply)) return finish(null, { clean: true });
      finish(new Error(`ClamAV error: ${reply || 'empty reply'}`));
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const CH = 64 * 1024;
      for (let i = 0; i < data.length; i += CH) {
        const part = data.subarray(i, i + CH);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
  });
}
