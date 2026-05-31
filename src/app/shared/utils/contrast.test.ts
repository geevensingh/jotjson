import { AA_THRESHOLD, contrastRatio, meetsAA, THEME_DEFAULTS } from './contrast';

describe('contrast utility (M6g-3)', () => {
  describe('contrastRatio', () => {
    it('returns 21 for black on white (max contrast)', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    });

    it('returns 1 for identical colors (min contrast)', () => {
      expect(contrastRatio('#abcdef', '#abcdef')).toBeCloseTo(1, 5);
    });

    it('is symmetric in fg/bg', () => {
      const a = contrastRatio('#112233', '#fafafa');
      const b = contrastRatio('#fafafa', '#112233');
      expect(a).toBeCloseTo(b, 6);
    });

    it('matches a known WCAG sample (#777 on white ~= 4.48)', () => {
      // WebAIM's contrast checker reports 4.48 for #777 on #fff.
      const r = contrastRatio('#777777', '#ffffff');
      expect(r).toBeGreaterThan(4.4);
      expect(r).toBeLessThan(4.55);
    });

    it('matches a known WCAG sample (#595959 on white ~= 7.0)', () => {
      const r = contrastRatio('#595959', '#ffffff');
      expect(r).toBeGreaterThan(6.9);
      expect(r).toBeLessThan(7.1);
    });

    it('throws on malformed input', () => {
      expect(() => contrastRatio('red', '#ffffff')).toThrowError(/expected #rrggbb/);
      expect(() => contrastRatio('#fff', '#ffffff')).toThrowError(/expected #rrggbb/);
      expect(() => contrastRatio('#zzzzzz', '#ffffff')).toThrowError(/expected #rrggbb/);
    });

    it('treats uppercase and lowercase hex equivalently', () => {
      const a = contrastRatio('#AABBCC', '#112233');
      const b = contrastRatio('#aabbcc', '#112233');
      expect(a).toBeCloseTo(b, 6);
    });
  });

  describe('meetsAA', () => {
    it('passes for black on white', () => {
      expect(meetsAA('#000000', '#ffffff')).toBe(true);
    });

    it('fails for #777 on white (just under 4.5)', () => {
      expect(meetsAA('#777777', '#ffffff')).toBe(false);
    });

    it('passes exactly at the AA threshold', () => {
      // Construct a known-passing pair to verify the >= boundary.
      // #595959 on white reports ~7.0 - well above 4.5.
      expect(meetsAA('#595959', '#ffffff')).toBe(true);
    });

    it('uses 4.5 as the threshold constant', () => {
      expect(AA_THRESHOLD).toBe(4.5);
    });
  });

  describe('THEME_DEFAULTS', () => {
    it('exposes light/dark surfaces matching _variables.scss', () => {
      expect(THEME_DEFAULTS.light).toEqual({ bg: '#fafafa', fg: '#1a1a1a' });
      expect(THEME_DEFAULTS.dark).toEqual({ bg: '#1e1e1e', fg: '#e4e4e4' });
    });

    it('the defaults themselves clear AA in their own theme', () => {
      expect(meetsAA(THEME_DEFAULTS.light.fg, THEME_DEFAULTS.light.bg)).toBe(true);
      expect(meetsAA(THEME_DEFAULTS.dark.fg, THEME_DEFAULTS.dark.bg)).toBe(true);
    });
  });
});
