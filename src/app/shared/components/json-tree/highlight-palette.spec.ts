import {
  HIGHLIGHT_PALETTE_DARK,
  HIGHLIGHT_PALETTE_LIGHT,
  contrastText,
  type PaletteSwatch,
} from './highlight-palette';

describe('highlight palette', () => {
  describe('contrastText', () => {
    it('chooses black text for white and light mid-gray backgrounds', () => {
      expect(contrastText('#ffffff')).toBe('#000000');
      expect(contrastText('#fff')).toBe('#000000');
      expect(contrastText('#888888')).toBe('#000000');
    });

    it('chooses white text for black backgrounds', () => {
      expect(contrastText('#000000')).toBe('#ffffff');
      expect(contrastText('#000')).toBe('#ffffff');
    });

    it('chooses the expected text color for every light palette swatch', () => {
      expectPaletteContrast(HIGHLIGHT_PALETTE_LIGHT, '#000000');
    });

    it('chooses the expected text color for every dark palette swatch', () => {
      expectPaletteContrast(HIGHLIGHT_PALETTE_DARK, '#ffffff');
    });

    it('handles representative author-chosen colors', () => {
      expect(contrastText('#123456')).toBe('#ffffff');
      expect(contrastText('#ffeb3b')).toBe('#000000');
      expect(contrastText('#0d47a1')).toBe('#ffffff');
      expect(contrastText('#fefefe')).toBe('#000000');
    });
  });
});

function expectPaletteContrast(
  palette: readonly PaletteSwatch[],
  expectedTextColor: '#000000' | '#ffffff',
): void {
  for (const swatch of palette) {
    expect(contrastText(swatch.hex)).withContext(swatch.hex).toBe(expectedTextColor);
  }
}
