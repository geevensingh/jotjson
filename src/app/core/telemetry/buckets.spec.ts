import { bucketBytes, bucketCount, bucketLineCount } from './buckets';

describe('telemetry bucket helpers', () => {
  describe('bucketBytes', () => {
    it('returns "<1KB" for values under 1024 bytes', () => {
      expect(bucketBytes(0)).toBe('<1KB');
      expect(bucketBytes(1023)).toBe('<1KB');
    });

    it('returns "1-10KB" at the lower boundary 1024', () => {
      expect(bucketBytes(1024)).toBe('1-10KB');
    });

    it('returns "1-10KB" just under 10KB', () => {
      expect(bucketBytes(10 * 1024 - 1)).toBe('1-10KB');
    });

    it('returns "10-100KB" at the lower boundary 10KB', () => {
      expect(bucketBytes(10 * 1024)).toBe('10-100KB');
    });

    it('returns "10-100KB" just under 100KB', () => {
      expect(bucketBytes(100 * 1024 - 1)).toBe('10-100KB');
    });

    it('returns "100KB-1MB" at the lower boundary 100KB', () => {
      expect(bucketBytes(100 * 1024)).toBe('100KB-1MB');
    });

    it('returns "100KB-1MB" just under 1MB', () => {
      expect(bucketBytes(1024 * 1024 - 1)).toBe('100KB-1MB');
    });

    it('returns ">1MB" at and above 1MB', () => {
      expect(bucketBytes(1024 * 1024)).toBe('>1MB');
      expect(bucketBytes(50 * 1024 * 1024)).toBe('>1MB');
    });

    it('clamps NaN and negative values to "<1KB"; Infinity to ">1MB"', () => {
      expect(bucketBytes(-1)).toBe('<1KB');
      expect(bucketBytes(NaN)).toBe('<1KB');
      expect(bucketBytes(-Infinity)).toBe('<1KB');
      expect(bucketBytes(Infinity)).toBe('>1MB');
    });
  });

  describe('bucketCount', () => {
    it('returns "<100" for small counts', () => {
      expect(bucketCount(0)).toBe('<100');
      expect(bucketCount(99)).toBe('<100');
    });

    it('returns "100-1K" at the lower boundary 100', () => {
      expect(bucketCount(100)).toBe('100-1K');
      expect(bucketCount(999)).toBe('100-1K');
    });

    it('returns "1K-10K" at the lower boundary 1000', () => {
      expect(bucketCount(1000)).toBe('1K-10K');
      expect(bucketCount(9999)).toBe('1K-10K');
    });

    it('returns ">10K" at and above 10000', () => {
      expect(bucketCount(10000)).toBe('>10K');
      expect(bucketCount(1_000_000)).toBe('>10K');
    });

    it('clamps NaN and negative values to "<100"; Infinity to ">10K"', () => {
      expect(bucketCount(-5)).toBe('<100');
      expect(bucketCount(NaN)).toBe('<100');
      expect(bucketCount(Infinity)).toBe('>10K');
    });
  });

  describe('bucketLineCount', () => {
    it('returns "1" for an empty string', () => {
      expect(bucketLineCount('')).toBe('1');
    });

    it('returns "1" for a string with no line breaks', () => {
      expect(bucketLineCount('hello world')).toBe('1');
    });

    it('returns "2-5" for a single \\n', () => {
      expect(bucketLineCount('a\nb')).toBe('2-5');
    });

    it('returns "2-5" at the upper boundary of 5 lines (4 breaks)', () => {
      expect(bucketLineCount('1\n2\n3\n4\n5')).toBe('2-5');
    });

    it('returns "6-20" at the lower boundary of 6 lines (5 breaks)', () => {
      expect(bucketLineCount('1\n2\n3\n4\n5\n6')).toBe('6-20');
    });

    it('returns "6-20" at the upper boundary of 20 lines (19 breaks)', () => {
      const text = Array.from({ length: 20 }, (_, i) => String(i)).join('\n');
      expect(bucketLineCount(text)).toBe('6-20');
    });

    it('returns "21-100" at the lower boundary of 21 lines (20 breaks)', () => {
      const text = Array.from({ length: 21 }, (_, i) => String(i)).join('\n');
      expect(bucketLineCount(text)).toBe('21-100');
    });

    it('returns "21-100" at the upper boundary of 100 lines (99 breaks)', () => {
      const text = Array.from({ length: 100 }, (_, i) => String(i)).join('\n');
      expect(bucketLineCount(text)).toBe('21-100');
    });

    it('returns "100+" at and above 101 lines (100 breaks)', () => {
      const text = Array.from({ length: 101 }, (_, i) => String(i)).join('\n');
      expect(bucketLineCount(text)).toBe('100+');
      const huge = Array.from({ length: 5000 }, () => 'x').join('\n');
      expect(bucketLineCount(huge)).toBe('100+');
    });

    it('treats CRLF as a single line break', () => {
      expect(bucketLineCount('a\r\nb')).toBe('2-5');
      expect(bucketLineCount('1\r\n2\r\n3\r\n4\r\n5')).toBe('2-5');
    });

    it('treats a bare \\r (old Mac) as a line break', () => {
      expect(bucketLineCount('a\rb')).toBe('2-5');
    });

    it('counts mixed \\r and \\n correctly', () => {
      // \r alone, \n alone, \r\n: three line breaks, four lines total
      expect(bucketLineCount('a\rb\nc\r\nd')).toBe('2-5');
    });
  });
});
