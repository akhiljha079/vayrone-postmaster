import { randomBytes } from 'node:crypto';

export function mid(): string {
  return `<${randomBytes(8).toString('hex')}@test.local>`;
}

export function simpleMessage(o: { from?: string; to?: string; subject?: string; body?: string; messageId?: string } = {}): string {
  return [
    `From: ${o.from ?? 'Alice <alice@example.com>'}`,
    `To: ${o.to ?? 'bob@example.com'}`,
    `Subject: ${o.subject ?? 'Hello'}`,
    `Date: Mon, 05 Oct 2026 10:00:00 +0530`,
    `Message-ID: ${o.messageId ?? mid()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body ?? 'Hello Bob,\r\nThis is a test.\r\n.dot line\r\n',
  ].join('\r\n');
}

/** multipart/mixed( multipart/alternative(text, html), attachment, message/rfc822 ) */
export function complexMessage(messageId = mid()): string {
  const inner = [
    'From: Carol <carol@example.org>',
    'To: alice@example.com',
    'Subject: Inner forwarded',
    'Message-ID: <inner@example.org>',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'Forwarded body line 1',
    'Forwarded body line 2',
  ].join('\r\n');
  return [
    'From: =?UTF-8?B?w4VzYQ==?= <asa@example.com>',
    'To: "Bob B." <bob@example.com>, team: x@example.com, y@example.com;',
    'Cc: carol@example.org',
    'Subject: =?UTF-8?Q?Re=3A_Caf=C3=A9_plans?=',
    'Date: Tue, 06 Oct 2026 09:15:00 +0000',
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    'Preamble text',
    '--outer',
    'Content-Type: multipart/alternative; boundary=alt',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=C3=A9 at nine? searchable-token',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Caf&eacute; at <b>nine</b>?</p>',
    '--alt--',
    '',
    '--outer',
    'Content-Type: application/pdf; name="plan.pdf"',
    'Content-Disposition: attachment; filename="plan.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQKJcfsj6IK',
    '--outer',
    'Content-Type: message/rfc822',
    '',
    inner,
    '--outer--',
    '',
  ].join('\r\n');
}
