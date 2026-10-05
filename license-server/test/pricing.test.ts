import { describe, expect, it } from 'vitest';
import { quote, slabFor, validateSlabs } from '../src/services/pricing.js';
import { normalizePhone } from '../src/services/notify.js';
import { localDate, reminderText } from '../src/services/reminders.js';

const SLABS = [
  { upTo: 25, pricePerUser: 1200 },
  { upTo: 100, pricePerUser: 1000 },
  { upTo: null, pricePerUser: 850 },
];

describe('slab pricing', () => {
  it('prices the whole order at the slab its user count falls into', () => {
    expect(slabFor(SLABS, 25).pricePerUser).toBe(1200);
    expect(slabFor(SLABS, 26).pricePerUser).toBe(1000);
    expect(slabFor(SLABS, 5000).pricePerUser).toBe(850);
    const q = quote({ slabs: SLABS, amc_pct: 20, term_months: 12, min_users: 5 }, 40, 2, 10);
    expect(q).toMatchObject({ users: 40, years: 2, unitPrice: 1000, base: 80000, discount: 8000, net: 72000, gst: 12960, total: 84960, amcPerYear: 0 });
  });

  it('perpetual plans are one-time with a yearly AMC; the minimum user count applies', () => {
    const q = quote({ slabs: SLABS, amc_pct: 20, term_months: 0, min_users: 10 }, 3, 3);
    expect(q).toMatchObject({ users: 10, years: 1, base: 12000, amcPerYear: 2400, perpetual: true });
  });

  it('validates slab tables', () => {
    expect(validateSlabs(SLABS)).toBeNull();
    expect(validateSlabs([{ upTo: 10, pricePerUser: 1 }])).toMatch(/no upper limit/);
    expect(validateSlabs([{ upTo: null, pricePerUser: 1 }, { upTo: null, pricePerUser: 2 }])).toMatch(/Only one/);
    expect(validateSlabs([])).toMatch(/at least one/);
  });
});

describe('reminder helpers', () => {
  it('normalises Indian mobile numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('919876543210');
    expect(normalizePhone('+91-98765-43210')).toBe('919876543210');
    expect(normalizePhone('09876543210')).toBe('919876543210');
    expect(normalizePhone('12345')).toBeNull();
  });

  it('uses the India calendar date and explains the grace period', () => {
    expect(localDate(new Date('2026-03-31T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-04-01');
    const d = { id: 1, license_id: 'LIC-2026-000001', due: new Date(), company: 'Agra Steel', contact_name: 'Ravi', email: null, phone: null, whatsapp: null, reseller_name: null, reseller_email: null, reseller_phone: null, max_users: 25, plan: 'Business' };
    expect(reminderText('expiry', d, 7, '2026-04-08', '0562-000000').text).toMatch(/expires on 8 April 2026, in 7 day\(s\)[\s\S]*contact Vayrone Infratech \(0562-000000\)/);
    expect(reminderText('expiry', d, -7, '2026-04-08', '').text).toMatch(/expired on 8 April 2026[\s\S]*on 23 April 2026 the admin panel becomes read-only \(mail keeps flowing\)/);
    expect(reminderText('amc', { ...d, reseller_name: 'Taj IT', reseller_phone: '99999' }, 30, '2026-05-01', '').text).toMatch(/Annual Maintenance Contract[\s\S]*contact Taj IT \(99999\)/);
  });
});
