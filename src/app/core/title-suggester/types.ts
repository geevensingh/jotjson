/**
 * Title-suggester types.
 *
 * The service composes a small set of pure strategy functions to
 * generate candidate titles for a JSON document. Each strategy
 * inspects the parsed JSON (and optionally the raw text + last
 * filename) and returns a single `SuggestionCandidate` or `null`.
 *
 * Confidence is a simple ordinal used to sort the final list before
 * dedupe + cap; absolute values are not user-visible.
 */

/**
 * Closed enum naming each strategy. Used as the `source` field on a
 * `SuggestionCandidate` and as the `props.source` dimension on the
 * `toolbar.titleSuggestionAccepted` telemetry event, so total
 * cardinality is bounded by this list.
 */
export type SuggestionSource =
  | 'filename'
  | 'packageJson'
  | 'kubernetes'
  | 'openapi'
  | 'jsonSchema'
  | 'geojson'
  | 'armTemplate'
  | 'tsconfig'
  | 'githubActionsWorkflow'
  | 'postmanCollection'
  | 'selfUrl'
  | 'namedField'
  | 'typeField'
  | 'topLevelKeys'
  | 'descriptionFallback'
  | 'arrayShape'
  | 'objectShape'
  | 'primitive'
  | 'firstChars'
  | 'untitled'
  | 'dateStamped'
  | 'numberedUntitled';

export interface SuggestionCandidate {
  /** Final, ready-for-display title. Already truncated to <=200 chars. */
  readonly value: string;
  /** Which strategy produced this candidate. */
  readonly source: SuggestionSource;
  /**
   * Ordinal used for sorting. Higher = preferred. Absolute values are
   * implementation detail; only relative ordering is meaningful.
   */
  readonly confidence: number;
}

/**
 * Input to the suggester. The home component populates this from its
 * existing `content` signal and `parseResult` computed (so we don't
 * re-parse) plus the new `lastFilename` signal.
 */
export interface SuggestionInput {
  /** Raw editor text. Used by `firstChars` strategy. */
  readonly jsonText: string;
  /** Parsed JSON value, or `undefined` when parsing failed. */
  readonly parsed: unknown;
  /** True when `parseResult.errors.length > 0`. */
  readonly hasParseErrors: boolean;
  /**
   * The most recent file name that populated the editor (via upload
   * or drag-drop), or `null` if the current document did not come
   * from a file. Lifecycle is owned by `home.component.ts`.
   */
  readonly filename: string | null;
}

/**
 * A pure strategy function. Returns a candidate or `null` when the
 * strategy doesn't apply to the input.
 */
export type SuggestionStrategy = (input: SuggestionInput) => SuggestionCandidate | null;
