/**
 * Detection + decode helpers for strings whose line breaks were
 * lossy-transcoded to literal "??" characters - common in Microsoft /
 * Azure dependent-service log payloads where multi-line content (HTTP
 * request / response framing in particular) gets flattened into a
 * single JSON string with each line break replaced by `??` and any
 * blank line replaced by `????`.
 *
 * The helpers are intentionally heuristic and approximate. They drive
 * a non-destructive *suggestion* UI affordance (the "Show `??` as line
 * breaks" toggle in the Inspect-string-value dialog), not an automatic
 * rewrite. False positives surface a toggle the user can flip on and
 * back off at zero cost.
 *
 * Detection rule (v1.3): a string is flagged as containing lossy line-
 * break mangling when it has more non-overlapping `??` pairs than
 * preserved line breaks (any of `\r\n`, `\n`, `\r`). The intuition is
 * "if the only line-break-shaped runs in this string are `??`, then
 * `??` probably represents a line break". The rule is permissive on
 * purpose: a string like `"a ?? b"` will trip it, but the cost of a
 * false positive is one extra dialog-local toggle flip - the toggle
 * defaults off, the dialog still works as today when the user ignores
 * the toggle, and Apply (the only destructive action) is gated behind
 * an explicit click on the decoded preview.
 *
 * The API shape is discriminated-union-by-`kind` so future mangling
 * shapes (stack traces, PEM blocks, exception details, ...) can be
 * added additively without breaking existing call sites. The
 * `'httpFraming'` kind name is retained for telemetry stability and
 * because the decoder still emits HTTP-canonical CRLF framing (with
 * `\r\n\r\n` at any `????` body separator); detection has broadened
 * since the original HTTP-shape-only gate but the decoder's output
 * shape is unchanged.
 *
 * Both `detectLossyMangling` and `decodeLossyMangling` are pure,
 * deterministic, and O(n) in the length of the input.
 */

/**
 * Discriminated detection result. `kind === 'none'` means no detected
 * mangling. Future kinds (`stackTrace`, `pem`, ...) extend this union
 * additively, not by breaking the existing call sites.
 */
export type LossyManglingKind = 'none' | 'httpFraming';

export interface LossyManglingDetection {
  readonly kind: LossyManglingKind;
}

/**
 * The "headers / body" separator that appears when a blank line
 * (CRLF + CRLF, or any other doubled line break) is lossy-transcoded
 * by the same pipeline that maps single line breaks to `??`. The
 * decoder treats `????` as an HTTP-style header/body boundary: the
 * portion before it is rewritten line-by-line and the portion after
 * it is preserved verbatim.
 */
const HTTP_BODY_SEPARATOR = '????';

/**
 * Regex used for counting "actual" line breaks: CRLF, lone CR, or
 * lone LF. Matches the dialog preview's own line-splitter, so the
 * detector counts what the user would see as a line break if the
 * string were rendered raw.
 */
const LINE_BREAK_RE = /\r\n|\r|\n/g;

/**
 * Count non-overlapping occurrences of `needle` in `haystack`. Used
 * for the `??` tally in {@link detectLossyMangling}. `String.match`
 * with a regex literal would do the same job, but the indexOf walk
 * is allocation-free and stride-correct for an arbitrary literal.
 */
function countNonOverlapping(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Classify a string for known lossy-mangling shapes. Pure, O(n), no
 * I/O. Returns `{ kind: 'none' }` when nothing matches; callers should
 * treat `'none'` as "render the raw value as-is".
 *
 * v1.3 detection rule: fires `'httpFraming'` when the value contains
 * more non-overlapping `??` markers than preserved line breaks (any
 * of `\r\n`, `\n`, `\r`). Strings with no `??` short-circuit to
 * `'none'`; strings whose line-break count already meets or exceeds
 * the `??` count are treated as either already-multi-line content
 * (no recovery needed) or content where `??` is most likely literal
 * (e.g. JavaScript nullish-coalescing inside a multi-line snippet).
 */
export function detectLossyMangling(value: string): LossyManglingDetection {
  if (!value.includes('??')) return { kind: 'none' };
  const questionPairs = countNonOverlapping(value, '??');
  const lineBreakMatches = value.match(LINE_BREAK_RE);
  const lineBreaks = lineBreakMatches === null ? 0 : lineBreakMatches.length;
  return questionPairs > lineBreaks ? { kind: 'httpFraming' } : { kind: 'none' };
}

/**
 * Decoder pair to {@link detectLossyMangling}. `kind === 'none'`
 * returns the input unchanged (idempotent for values where no shape
 * was detected). `kind === 'httpFraming'` rewrites `??` to `\r\n`:
 *
 * - When the input contains a `????` "header / body" separator the
 *   decoder is **prefix-only**: only the section before `????` is
 *   rewritten line-by-line, the separator becomes a CRLF blank line
 *   (`\r\n\r\n`), and the body (everything after the separator) is
 *   preserved verbatim so that URLs, base64 fragments, or recursively-
 *   mangled payloads inside the body are not silently corrupted.
 * - When the input has no `????` separator the decoder falls back to
 *   a straight global replace `??` -> `\r\n`. There is no second
 *   level of body-aware preservation in this case; the user already
 *   sees the result before committing it via Apply.
 *
 * CRLF (not LF) is emitted so any tool that later round-trips the
 * string through a real HTTP parser sees spec-canonical framing. The
 * dialog preview's line-splitter (`/\r\n|\r|\n/`) handles any line-
 * break form, so the rendered output is visually identical regardless
 * of the byte choice.
 *
 * Worked example (HTTP response with body separator):
 *   in:  `200 OK??Pragma: no-cache??Expires: -1????{"body":"..."}`
 *   out: `200 OK\r\nPragma: no-cache\r\nExpires: -1\r\n\r\n{"body":"..."}`
 *
 * Worked example with `??` in the body:
 *   in:  `200 OK??Foo: a??Bar: b??Baz: c????GET /x?a??b=1`
 *   out: `200 OK\r\nFoo: a\r\nBar: b\r\nBaz: c\r\n\r\nGET /x?a??b=1`
 *
 * Worked example with no `????` separator (fallback global replace):
 *   in:  `Wait what?? Is that real?? Surely not??`
 *   out: `Wait what\r\n Is that real\r\n Surely not\r\n`
 *
 * Performance: O(n) over input length. The dialog's existing `lines`
 * computed re-runs its line-splitter over the decoded output - also
 * O(n). Toggle flips are memoised by Angular's `computed()` (one
 * compute per distinct `decoded()` value, not per click), so no
 * further caching is needed at v1 scale.
 */
export function decodeLossyMangling(value: string, kind: LossyManglingKind): string {
  switch (kind) {
    case 'none':
      return value;
    case 'httpFraming':
      return decodeHttpFraming(value);
  }
  const exhaustiveKind: never = kind;
  return exhaustiveKind;
}

function decodeHttpFraming(value: string): string {
  const bodyStart = value.indexOf(HTTP_BODY_SEPARATOR);
  if (bodyStart >= 0) {
    // Standard case: header block then `????` then body. Substitute
    // `??` -> `\r\n` only inside the header block; preserve the body
    // verbatim (so URLs, base64, or recursively-mangled content in the
    // body are not silently corrupted). `????` -> `\r\n\r\n` is
    // spec-canonical HTTP framing (blank line separating headers from
    // body, where the blank line is itself CRLF).
    const headerPart = value.slice(0, bodyStart).split('??').join('\r\n');
    const bodyPart = value.slice(bodyStart + HTTP_BODY_SEPARATOR.length);
    return headerPart + '\r\n\r\n' + bodyPart;
  }

  // Fallback: no `????` separator. The detection rule (count('??') >
  // count(line breaks)) doesn't tell us where a header section ends,
  // so we just replace every `??` with `\r\n`. The user previews the
  // result via the toggle before deciding to Apply, so a wrong
  // decoding is recoverable.
  return value.split('??').join('\r\n');
}
