import { describe, expect, it } from 'vitest';
import { arrivalDate } from '../src/fetch/fetch.js';

describe('arrival date for "download mail received from"', () => {
  it("uses the provider's Received: time, folded headers included", () => {
    const head = 'Received: from mx.client.test (mx.client.test [1.2.3.4])\r\n\tby mx.provider.test with ESMTPS id abc\r\n\tfor <a@b.test>; Thu, 01 Oct 2026 08:30:00 +0530 (IST)\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\nSubject: x\r\n\r\nbody';
    expect(arrivalDate(head)?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });
  it('falls back to Date: and never guesses', () => {
    expect(arrivalDate('Subject: x\r\nDate: Tue, 15 Sep 2026 10:00:00 +0000\r\n\r\n')?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(arrivalDate('Subject: no dates\r\n\r\n')).toBeNull();
    expect(arrivalDate('Date: not a date\r\n\r\n')).toBeNull();
  });
});
