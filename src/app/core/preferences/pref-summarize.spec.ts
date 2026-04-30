import {
  bucketColorHex,
  bucketDepth,
  bucketFontSize,
  bucketTabSize
} from './pref-summarize';
import type { ColorBucket } from './pref-summarize';

describe('preference telemetry summary helpers', () => {
  describe('bucketColorHex', () => {
    it('returns the expected bucket for representative hues and defaults', () => {
      const cases: readonly { hex: string; bucket: ColorBucket }[] = [
        { hex: '#ff0000', bucket: 'red' },
        { hex: '#ff8000', bucket: 'orange' },
        { hex: '#ffff00', bucket: 'yellow' },
        { hex: '#00ff00', bucket: 'green' },
        { hex: '#00ffff', bucket: 'teal' },
        { hex: '#0000ff', bucket: 'blue' },
        { hex: '#8000ff', bucket: 'purple' },
        { hex: '#ff00ff', bucket: 'pink' },
        { hex: '#264f78', bucket: 'blue' },
        { hex: '#3e3d32', bucket: 'gray' },
        { hex: '#cce4f7', bucket: 'blue' },
        { hex: '#fff4cc', bucket: 'yellow' }
      ];

      for (const testCase of cases) {
        expect(bucketColorHex(testCase.hex)).toBe(testCase.bucket);
      }
    });

    it('returns custom for invalid hex strings', () => {
      expect(bucketColorHex('garbage')).toBe('custom');
      expect(bucketColorHex('')).toBe('custom');
      expect(bucketColorHex('#fff')).toBe('custom');
      expect(bucketColorHex('#zzzzzz')).toBe('custom');
    });

    it('returns gray for low-saturation colors', () => {
      expect(bucketColorHex('#808080')).toBe('gray');
      expect(bucketColorHex('#2a2d2e')).toBe('gray');
    });
  });

  describe('bucketFontSize', () => {
    it('buckets representative values and boundaries', () => {
      expect(bucketFontSize(9)).toBe('<10');
      expect(bucketFontSize(10)).toBe('10-12');
      expect(bucketFontSize(12)).toBe('10-12');
      expect(bucketFontSize(13)).toBe('13-14');
      expect(bucketFontSize(14)).toBe('13-14');
      expect(bucketFontSize(15)).toBe('15-16');
      expect(bucketFontSize(16)).toBe('15-16');
      expect(bucketFontSize(17)).toBe('17-20');
      expect(bucketFontSize(20)).toBe('17-20');
      expect(bucketFontSize(21)).toBe('>20');
    });
  });

  describe('bucketDepth', () => {
    it('buckets representative values and boundaries', () => {
      expect(bucketDepth(0)).toBe('0');
      expect(bucketDepth(1)).toBe('1');
      expect(bucketDepth(2)).toBe('2');
      expect(bucketDepth(3)).toBe('3-5');
      expect(bucketDepth(5)).toBe('3-5');
      expect(bucketDepth(6)).toBe('6-10');
      expect(bucketDepth(10)).toBe('6-10');
      expect(bucketDepth(11)).toBe('>10');
    });
  });

  describe('bucketTabSize', () => {
    it('buckets representative values', () => {
      expect(bucketTabSize(2)).toBe('2');
      expect(bucketTabSize(4)).toBe('4');
      expect(bucketTabSize(8)).toBe('other');
    });
  });
});
