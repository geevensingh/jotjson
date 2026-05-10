/**
 * Pure helper used by the cold-boot inline `<script>` in `src/index.html`
 * to decide whether to apply an explicit `theme-dark` / `theme-light` body
 * class before the static splash paints. The inline script transcribes the
 * same logic byte-for-byte so the splash never flashes the wrong palette
 * when the user's stored preference disagrees with their OS color scheme.
 *
 * Inputs:
 *   - `rawJson`: the raw string read from
 *     `localStorage['jotjson.preferences.v1']` (or `null` if missing).
 *
 * Returns:
 *   - `'dark'` / `'light'` when an explicit override is stored.
 *   - `null` when the input is absent, malformed, or the stored
 *     preference is `'system'` / unknown - in which case the existing
 *     `prefers-color-scheme` media-query in the splash stylesheet stays
 *     authoritative.
 *
 * Constraints:
 *   - Pure: no DOM, no `localStorage`, no globals.
 *   - Total: never throws on bad input. The inline copy in `index.html`
 *     is wrapped in `try { ... } catch {}` defensively, but keeping this
 *     helper total means the production behavior on malformed JSON is
 *     identical to a never-set localStorage key (no-op), not a flash of
 *     the wrong palette.
 */
export type ResolvedBootTheme = 'dark' | 'light' | null;

export function resolveBootTheme(rawJson: string | null): ResolvedBootTheme {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { theme?: unknown };
    if (parsed.theme === 'dark' || parsed.theme === 'light') return parsed.theme;
    return null;
  } catch {
    return null;
  }
}
