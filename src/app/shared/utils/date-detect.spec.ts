import {
  __resetLocaleOrderCacheForTesting,
  detectLocaleDateOrder,
  formatDateAnnotation,
  formatRelative,
  parseAsDate
} from './date-detect';

describe('date-detect', () => {
  beforeEach(() => __resetLocaleOrderCacheForTesting());

  describe('parseAsDate - ISO 8601 with time', () => {
    it('parses ISO with Z', () => {
      const got = parseAsDate('2024-11-05T18:30:00Z');
      expect(got).not.toBeNull();
      expect(got!.hasTime).toBe(true);
      expect(got!.date.toISOString()).toBe('2024-11-05T18:30:00.000Z');
    });

    it('parses ISO with offset', () => {
      const got = parseAsDate('2024-11-05T10:30:00-08:00');
      expect(got).not.toBeNull();
      expect(got!.date.toISOString()).toBe('2024-11-05T18:30:00.000Z');
    });

    it('parses ISO without seconds', () => {
      expect(parseAsDate('2024-11-05T18:30Z')).not.toBeNull();
    });

    it('parses ISO with milliseconds', () => {
      expect(parseAsDate('2024-11-05T18:30:00.123Z')).not.toBeNull();
    });
  });

  describe('parseAsDate - ISO date-only', () => {
    it('parses YYYY-MM-DD', () => {
      const got = parseAsDate('2024-11-05');
      expect(got).not.toBeNull();
      expect(got!.hasTime).toBe(false);
      expect(got!.date.getFullYear()).toBe(2024);
      expect(got!.date.getMonth()).toBe(10);
      expect(got!.date.getDate()).toBe(5);
    });

    it('rejects calendar overflow like 2024-02-30', () => {
      expect(parseAsDate('2024-02-30')).toBeNull();
    });

    it('rejects 2024-13-99', () => {
      expect(parseAsDate('2024-13-99')).toBeNull();
    });
  });

  describe('parseAsDate - slash format', () => {
    it('uses MDY for en-US', () => {
      const got = parseAsDate('05/06/2024', 'en-US');
      expect(got).not.toBeNull();
      expect(got!.date.getMonth()).toBe(4);
      expect(got!.date.getDate()).toBe(6);
    });

    it('uses DMY for en-GB', () => {
      const got = parseAsDate('05/06/2024', 'en-GB');
      expect(got).not.toBeNull();
      expect(got!.date.getMonth()).toBe(5);
      expect(got!.date.getDate()).toBe(5);
    });

    it('rejects 2-digit-year slash form', () => {
      expect(parseAsDate('05/06/24', 'en-US')).toBeNull();
    });

    it('rejects calendar overflow in slash form', () => {
      expect(parseAsDate('13/45/2024', 'en-US')).toBeNull();
    });

    it('parses slash with optional time', () => {
      const got = parseAsDate('05/06/2024 14:30', 'en-US');
      expect(got).not.toBeNull();
      expect(got!.hasTime).toBe(true);
    });
  });

  describe('parseAsDate - RFC 2822 / human', () => {
    it('parses "Nov 5, 2024"', () => {
      const got = parseAsDate('Nov 5, 2024');
      expect(got).not.toBeNull();
      expect(got!.date.getMonth()).toBe(10);
      expect(got!.date.getDate()).toBe(5);
    });

    it('parses "5 Nov 2024"', () => {
      expect(parseAsDate('5 Nov 2024')).not.toBeNull();
    });

    it('parses "Mon, 5 Nov 2024 18:30:00 GMT"', () => {
      const got = parseAsDate('Mon, 5 Nov 2024 18:30:00 GMT');
      expect(got).not.toBeNull();
      expect(got!.hasTime).toBe(true);
    });
  });

  describe('parseAsDate - rejections', () => {
    [
      '',
      'hello',
      '12345',
      '42',
      'true',
      'false',
      'null',
      'undefined',
      '1700-01-01',
      '2200-01-01',
      'a really long string that contains digits 1234 mixed in',
      '01',
      '2024',
      'Foo 99, 9999'
    ].forEach((input) => {
      it(`rejects ${JSON.stringify(input)}`, () => {
        expect(parseAsDate(input)).toBeNull();
      });
    });

    it('rejects non-strings', () => {
      expect(parseAsDate(1700000000)).toBeNull();
      expect(parseAsDate(null)).toBeNull();
      expect(parseAsDate(undefined)).toBeNull();
      expect(parseAsDate({})).toBeNull();
    });
  });

  describe('detectLocaleDateOrder', () => {
    it('returns mdy for en-US', () => {
      expect(detectLocaleDateOrder('en-US')).toBe('mdy');
    });

    it('returns dmy for en-GB', () => {
      expect(detectLocaleDateOrder('en-GB')).toBe('dmy');
    });

    it('returns ymd for sv-SE', () => {
      expect(detectLocaleDateOrder('sv-SE')).toBe('ymd');
    });
  });

  describe('formatDateAnnotation', () => {
    it('joins absolute date and relative time with em-dash', () => {
      const parsed = parseAsDate('2024-11-05T18:30:00Z')!;
      const now = new Date('2024-11-05T18:35:00Z');
      const out = formatDateAnnotation(parsed, now, 'en-US')!;
      expect(out).toContain('\u2014');
      expect(out.toLowerCase()).toContain('5 minutes ago');
    });

    it('omits time component when source had no time', () => {
      const parsed = parseAsDate('2024-11-05')!;
      const now = new Date('2024-11-05T12:00:00Z');
      const out = formatDateAnnotation(parsed, now, 'en-US')!;
      expect(out).toMatch(/Nov 5, 2024/);
      expect(out).not.toMatch(/AM|PM|\d:\d{2}/);
    });

    it('handles future dates', () => {
      const parsed = parseAsDate('2025-01-01')!;
      const now = new Date('2024-11-05T00:00:00Z');
      const out = formatDateAnnotation(parsed, now, 'en-US')!;
      expect(out).toMatch(/in /);
    });
  });

  describe('configurable units', () => {
    const SECOND_MS = 1000;
    const MINUTE_MS = 60 * SECOND_MS;
    const HOUR_MS = 60 * MINUTE_MS;
    const DAY_MS = 24 * HOUR_MS;
    const MONTH_MS = 30.44 * DAY_MS;
    const now = new Date('2024-11-05T12:00:00Z');
    const allUnits = {
      year: true,
      month: true,
      day: true,
      hour: true,
      minute: true,
      second: true
    };
    const onlyYear = {
      year: true,
      month: false,
      day: false,
      hour: false,
      minute: false,
      second: false
    };
    const onlyMonth = {
      year: false,
      month: true,
      day: false,
      hour: false,
      minute: false,
      second: false
    };
    const onlyDay = {
      year: false,
      month: false,
      day: true,
      hour: false,
      minute: false,
      second: false
    };
    const noUnits = {
      year: false,
      month: false,
      day: false,
      hour: false,
      minute: false,
      second: false
    };

    function dateOffsetBy(offsetMs: number): Date {
      return new Date(now.getTime() + offsetMs);
    }

    it('uses days when year and month are disabled for a 130-day past delta', () => {
      const date = dateOffsetBy(-130 * DAY_MS);
      const units = { ...allUnits, year: false, month: false };
      expect(formatRelative(date, now, 'en-US', units)).toBe('130 days ago');
    });

    it('uses fractional minutes when seconds are disabled for a 30-second past delta', () => {
      const date = dateOffsetBy(-30 * SECOND_MS);
      const units = { ...allUnits, second: false };
      expect(formatRelative(date, now, 'en-US', units)).toBe('0.5 minutes ago');
    });

    it('uses adaptive hour precision when seconds and minutes are disabled for a 30-second past delta', () => {
      const date = dateOffsetBy(-30 * SECOND_MS);
      const units = { ...allUnits, minute: false, second: false };
      expect(formatRelative(date, now, 'en-US', units)).toBe('0.01 hours ago');
    });

    it('uses three decimal places when two decimal places would round a six-second delta to zero', () => {
      const date = dateOffsetBy(-6 * SECOND_MS);
      const units = { ...allUnits, minute: false, second: false };
      expect(formatRelative(date, now, 'en-US', units)).toBe('0.002 hours ago');
    });

    it('caps adaptive precision at zero after four decimal places', () => {
      const date = dateOffsetBy(SECOND_MS);
      expect(formatRelative(date, now, 'en-US', onlyYear, true)).toBe('this year');
      expect(formatRelative(date, now, 'en-US', onlyYear, false)).toBe('in 0 years');
    });

    it('returns null from relative and annotation formatters when all units are disabled', () => {
      const date = dateOffsetBy(-30 * SECOND_MS);
      const parsed = { date, hasTime: true };
      expect(formatRelative(date, now, 'en-US', noUnits)).toBeNull();
      expect(formatDateAnnotation(parsed, now, 'en-US', noUnits)).toBeNull();
    });

    it('uses friendly day forms for whole integer values when friendly forms are enabled', () => {
      const date = dateOffsetBy(DAY_MS);
      expect(formatRelative(date, now, 'en-US', onlyDay, true)).toBe('tomorrow');
    });

    it('uses numeric day forms for whole integer values when friendly forms are disabled', () => {
      const date = dateOffsetBy(DAY_MS);
      expect(formatRelative(date, now, 'en-US', onlyDay, false)).toBe('in 1 day');
    });

    it('uses friendly month forms for whole integer values when friendly forms are enabled', () => {
      const date = dateOffsetBy(-MONTH_MS);
      expect(formatRelative(date, now, 'en-US', onlyMonth, true)).toBe('last month');
    });

    it('uses numeric forms for fractional values even when friendly forms are enabled', () => {
      const date = dateOffsetBy(1.5 * DAY_MS);
      expect(formatRelative(date, now, 'en-US', onlyDay, true)).toBe('in 1.5 days');
    });
  });

  describe('parseAsDate - assumeUtcForIsoDateTime', () => {
    it('parses timezone-less ISO date-time as UTC when opt is true', () => {
      const withOpt = parseAsDate('2026-01-31T23:59:59.999', undefined, {
        assumeUtcForIsoDateTime: true
      })!;
      const reference = new Date('2026-01-31T23:59:59.999Z');
      expect(withOpt.date.getTime()).toBe(reference.getTime());
    });

    it('parses timezone-less ISO date-time as local when opt is false (default)', () => {
      const local = parseAsDate('2026-01-31T23:59:59.999')!;
      const expected = new Date('2026-01-31T23:59:59.999');
      expect(local.date.getTime()).toBe(expected.getTime());
    });

    it('does not modify ISO strings that already have Z', () => {
      const parsed = parseAsDate('2026-01-31T23:59:59Z', undefined, {
        assumeUtcForIsoDateTime: true
      })!;
      expect(parsed.date.getTime()).toBe(new Date('2026-01-31T23:59:59Z').getTime());
    });

    it('does not modify ISO strings that already have a positive offset', () => {
      const parsed = parseAsDate('2026-01-31T23:59:59+05:00', undefined, {
        assumeUtcForIsoDateTime: true
      })!;
      expect(parsed.date.getTime()).toBe(new Date('2026-01-31T23:59:59+05:00').getTime());
    });

    it('does not modify ISO strings that already have a negative offset', () => {
      const parsed = parseAsDate('2026-01-31T23:59:59-08:00', undefined, {
        assumeUtcForIsoDateTime: true
      })!;
      expect(parsed.date.getTime()).toBe(new Date('2026-01-31T23:59:59-08:00').getTime());
    });

    it('handles 7-digit fractional seconds (.NET round-trip) as UTC', () => {
      const parsed = parseAsDate('2026-01-31T23:59:59.9999999', undefined, {
        assumeUtcForIsoDateTime: true
      })!;
      // JS truncates beyond ms; the parsed instant matches the millisecond-precision UTC equivalent.
      expect(parsed.date.getTime()).toBe(new Date('2026-01-31T23:59:59.999Z').getTime());
    });
  });

  describe('parseAsDate - assumeUtcForIsoDateOnly', () => {
    it('parses YYYY-MM-DD as UTC midnight when opt is true', () => {
      const parsed = parseAsDate('2026-01-31', undefined, {
        assumeUtcForIsoDateOnly: true
      })!;
      expect(parsed.date.getTime()).toBe(Date.UTC(2026, 0, 31));
      expect(parsed.hasTime).toBe(false);
    });

    it('parses YYYY-MM-DD as local midnight when opt is false (default)', () => {
      const parsed = parseAsDate('2026-01-31')!;
      expect(parsed.date.getTime()).toBe(new Date(2026, 0, 31).getTime());
    });

    it('rejects calendar overflow when opt is true', () => {
      expect(parseAsDate('2024-02-30', undefined, { assumeUtcForIsoDateOnly: true })).toBeNull();
    });

    it('rejects out-of-range month when opt is true', () => {
      expect(parseAsDate('2024-13-01', undefined, { assumeUtcForIsoDateOnly: true })).toBeNull();
    });
  });

  describe('parseAsDate - assumeUtc opts do not affect non-ISO formats', () => {
    const opts = { assumeUtcForIsoDateTime: true, assumeUtcForIsoDateOnly: true };

    it('does not change slash-format parsing', () => {
      const a = parseAsDate('11/05/2024', 'en-US')!;
      const b = parseAsDate('11/05/2024', 'en-US', opts)!;
      expect(a.date.getTime()).toBe(b.date.getTime());
    });

    it('does not change RFC 2822 / human parsing', () => {
      const a = parseAsDate('Nov 5, 2024')!;
      const b = parseAsDate('Nov 5, 2024', undefined, opts)!;
      expect(a.date.getTime()).toBe(b.date.getTime());
    });
  });
});
