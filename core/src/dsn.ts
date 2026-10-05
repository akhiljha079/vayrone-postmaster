// Delivery Status Notifications (RFC 3464) for mail the relay could not deliver.
import { randomBytes } from 'node:crypto';

export interface DsnFailure {
  rcpt: string;
  code: number | null;
  response: string;
}

function rfc2822(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000');
}

/** Extracts an enhanced status code ("5.7.1") from an SMTP reply, or derives one from the basic code. */
export function enhancedStatus(f: DsnFailure): string {
  const m = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(f.response);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  if (f.code && f.code >= 500) return '5.0.0';
  return '4.0.0';
}

export function buildDsn(o: {
  hostname: string;
  to: string;
  originalHeaders: Buffer;
  failures: DsnFailure[];
  queueId: number;
  arrival: Date;
  expired?: boolean;
}): Buffer {
  const boundary = `vpm-dsn-${randomBytes(8).toString('hex')}`;
  const now = new Date();
  const list = o.failures.map((f) => `  <${f.rcpt}>\r\n    ${f.response.replace(/\r?\n/g, ' ')}`).join('\r\n\r\n');
  const reason = o.expired
    ? 'The message could not be delivered within the retry period and has been given up.'
    : 'The receiving server permanently rejected the message.';
  const perRcpt = o.failures
    .map((f) =>
      [
        `Final-Recipient: rfc822; ${f.rcpt}`,
        'Action: failed',
        `Status: ${enhancedStatus(f)}`,
        `Diagnostic-Code: smtp; ${f.response.replace(/\r?\n/g, ' ')}`,
      ].join('\r\n'),
    )
    .join('\r\n\r\n');
  const headers = o.originalHeaders.toString('latin1').replace(/(\r\n)+$/, '');
  const text = [
    `From: Mail Delivery System <MAILER-DAEMON@${o.hostname}>`,
    `To: <${o.to}>`,
    'Subject: Undelivered Mail Returned to Sender',
    `Date: ${rfc2822(now)}`,
    `Message-ID: <dsn.${o.queueId}.${randomBytes(6).toString('hex')}@${o.hostname}>`,
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `This is the Vayrone PostMaster mail server at ${o.hostname}.`,
    '',
    `Your message could not be delivered to the following recipient(s). ${reason}`,
    '',
    list,
    '',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    `Reporting-MTA: dns; ${o.hostname}`,
    `X-Vayrone-Queue-ID: ${o.queueId}`,
    `Arrival-Date: ${rfc2822(o.arrival)}`,
    '',
    perRcpt,
    '',
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    headers,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(text, 'utf8');
}
