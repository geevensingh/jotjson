/**
 * WCAG 2.1 contrast utilities for the Formatting Rules editor preview
 * (M6g-3). Hex-only input, six-digit `#rrggbb`. The model already
 * enforces this shape via `assertHex`, so callers can pass rule style
 * fields straight through.
 *
 * `THEME_DEFAULTS` mirror the canonical light/dark surface tokens in
 * `src/styles/_variables.scss` so that a rule with only one of
 * `textColor` / `backgroundColor` set is evaluated against the visible
 * theme surface for the missing channel.
 */

/**
 * Light / dark theme fallback colors. Keep in sync with
 * `src/styles/_variables.scss` (`$color-bg-light/dark`,
 * `$color-fg-light/dark`).
 */
export const THEME_DEFAULTS = {
  light: { bg: '#fafafa', fg: '#1a1a1a' },
  dark: { bg: '#1e1e1e', fg: '#e4e4e4' },
} as const;

/**
 * WCAG AA contrast threshold for normal-size body text. Large text
 * (18pt regular / 14pt bold) is allowed at 3.0, but tree rows are
 * neither, so we use the stricter bar everywhere.
 */
export const AA_THRESHOLD = 4.5;

function channelLinear(srgb: number): number {
  const c = srgb / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) {
    throw new Error(`contrast: expected #rrggbb hex, got ${hex}`);
  }
  const value = parseInt(m[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.2126 * channelLinear(r) + 0.7152 * channelLinear(g) + 0.0722 * channelLinear(b);
}

/**
 * Returns the WCAG 2.1 contrast ratio between two `#rrggbb` colors.
 * Result is in [1, 21]. Symmetric: `contrastRatio(a, b) ===
 * contrastRatio(b, a)`. Throws on malformed input.
 */
export function contrastRatio(foreground: string, background: string): number {
  const lFg = relativeLuminance(foreground);
  const lBg = relativeLuminance(background);
  const brighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (brighter + 0.05) / (darker + 0.05);
}

/**
 * True when the foreground/background pair clears the WCAG AA
 * threshold for normal body text (>= 4.5).
 */
export function meetsAA(foreground: string, background: string): boolean {
  return contrastRatio(foreground, background) >= AA_THRESHOLD;
}
