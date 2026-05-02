export interface PaletteSwatch {
  name: string;
  hex: string;
}

const YELLOW = $localize`:@@tree.highlight.swatch.yellow:Yellow`;
const AMBER = $localize`:@@tree.highlight.swatch.amber:Amber`;
const RED = $localize`:@@tree.highlight.swatch.red:Red`;
const PINK = $localize`:@@tree.highlight.swatch.pink:Pink`;
const PURPLE = $localize`:@@tree.highlight.swatch.purple:Purple`;
const BLUE = $localize`:@@tree.highlight.swatch.blue:Blue`;
const CYAN = $localize`:@@tree.highlight.swatch.cyan:Cyan`;
const GREEN = $localize`:@@tree.highlight.swatch.green:Green`;
const BROWN = $localize`:@@tree.highlight.swatch.brown:Brown`;
const GRAY = $localize`:@@tree.highlight.swatch.gray:Gray`;

export const HIGHLIGHT_PALETTE_LIGHT: readonly PaletteSwatch[] = [
  { name: YELLOW, hex: '#fff59d' },
  { name: AMBER, hex: '#ffd180' },
  { name: RED, hex: '#ffcdd2' },
  { name: PINK, hex: '#f8bbd0' },
  { name: PURPLE, hex: '#e1bee7' },
  { name: BLUE, hex: '#c5cae9' },
  { name: CYAN, hex: '#b3e5fc' },
  { name: GREEN, hex: '#c8e6c9' },
  { name: BROWN, hex: '#d7ccc8' },
  { name: GRAY, hex: '#e0e0e0' },
];

export const HIGHLIGHT_PALETTE_DARK: readonly PaletteSwatch[] = [
  { name: YELLOW, hex: '#7e6500' },
  { name: AMBER, hex: '#6a4a00' },
  { name: RED, hex: '#6e2c2c' },
  { name: PINK, hex: '#6e2c4c' },
  { name: PURPLE, hex: '#4c2c6e' },
  { name: BLUE, hex: '#2c3a6e' },
  { name: CYAN, hex: '#00425d' },
  { name: GREEN, hex: '#2a4a2a' },
  { name: BROWN, hex: '#5a3a2a' },
  { name: GRAY, hex: '#404040' },
];

/**
 * WCAG relative-luminance based contrast picker. Returns '#000000'
 * or '#ffffff' depending on which contrasts more with the supplied hex.
 */
export function contrastText(hex: string): '#000000' | '#ffffff' {
  const { red, green, blue } = parseHexColor(hex);
  const luminance =
    0.2126 * relativeChannelLuminance(red) +
    0.7152 * relativeChannelLuminance(green) +
    0.0722 * relativeChannelLuminance(blue);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}

function parseHexColor(hex: string): { red: number; green: number; blue: number } {
  const sixDigitMatch = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (sixDigitMatch) {
    return {
      red: Number.parseInt(sixDigitMatch[1] ?? '00', 16),
      green: Number.parseInt(sixDigitMatch[2] ?? '00', 16),
      blue: Number.parseInt(sixDigitMatch[3] ?? '00', 16),
    };
  }

  const threeDigitMatch = /^#([\da-f])([\da-f])([\da-f])$/i.exec(hex);
  if (threeDigitMatch) {
    const red = threeDigitMatch[1] ?? '0';
    const green = threeDigitMatch[2] ?? '0';
    const blue = threeDigitMatch[3] ?? '0';
    return {
      red: Number.parseInt(`${red}${red}`, 16),
      green: Number.parseInt(`${green}${green}`, 16),
      blue: Number.parseInt(`${blue}${blue}`, 16),
    };
  }

  throw new Error(`Unsupported highlight color: ${hex}`);
}

function relativeChannelLuminance(channel: number): number {
  const normalized = channel / 255;
  if (normalized <= 0.03928) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
}
