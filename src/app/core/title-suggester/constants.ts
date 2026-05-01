/**
 * Tunable constants for the title-suggester.
 *
 * - `TITLE_MAX_CHARS` matches the server-side cap in
 *   `api/src/shared/blob-validation.ts` and
 *   `DESIGN_SPEC.md` (200 chars after trim).
 * - `TITLE_CAP` limits the menu to 7 items per Miller's number; this
 *   matches the realistic max output of the strategy registry and
 *   keeps the menu scannable.
 */
export const TITLE_MAX_CHARS = 200;
export const TITLE_CAP = 7;

/** First-N raw chars used by the `firstChars` strategy. */
export const FIRST_CHARS_PREVIEW_LEN = 40;

/** Description / summary truncation cap used by `descriptionFallback`. */
export const DESCRIPTION_PREVIEW_LEN = 60;
