/**
 * Detection + decode helpers for log strings whose CRLF byte pairs were
 * lossy-transcoded to literal "??" characters. This is a common pattern
 * in Microsoft / Azure dependent-service traces where HTTP request and
 * response framing is flattened into a single JSON string with header
 * line breaks replaced by `??` and the headers / body boundary replaced
 * by `????`.
 *
 * The helpers are intentionally heuristic and approximate. They drive a
 * non-destructive *suggestion* UI affordance (the Decode toggle in the
 * Inspect-string-value dialog), not an automatic rewrite. False
 * negatives are acceptable (no toggle shown - the dialog still works
 * as today). False positives surface a toggle the user can ignore.
 *
 * The API shape is discriminated-union-by-`kind` so future mangling
 * shapes (stack traces, PEM blocks, exception details, ...) can be
 * added additively without breaking existing call sites.
 *
 * Both `detectLossyMangling` and `decodeLossyMangling` are pure,
 * deterministic, and O(n) in the length of the input. The decoder is
 * **prefix-only** for `httpFraming`: only the header section is
 * rewritten; any `??` in the body is preserved verbatim, so URLs,
 * base64 fragments, or recursively mangled payloads inside the body
 * are not silently corrupted.
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
 * Match shape used to count "??Name: <value>" header-like fragments.
 * Header-name grammar is intentionally narrow (letters then up to 40
 * letters / digits / hyphens) to dodge matching prose like
 * `"What?? Important: ..."`. The `\s\S` tail requires a non-empty
 * value, blocking matches such as `"...?? Hi: "` where the colon is
 * incidental punctuation.
 */
const HTTP_HEADER_SHAPE_RE = /\?\?[A-Za-z][A-Za-z0-9-]{0,40}:\s\S/g;

/**
 * Minimum number of header-shape matches required to classify a string
 * as `httpFraming`. Real HTTP responses have 5-15 headers, so 3 is
 * conservative; two-header responses fall below the gate by design.
 * Lowering this catches more (single-header / two-header responses)
 * at higher false-positive risk on prose.
 */
const HTTP_FRAMING_MIN_HEADER_MATCHES = 3;

/**
 * Anchored header-shape regex (same grammar as
 * {@link HTTP_HEADER_SHAPE_RE} but without the leading `??`, since the
 * fallback decoder tests segments produced by `split('??')`).
 */
const HTTP_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,40}:\s\S/;

/**
 * The "headers / body" separator in lossy-transcoded HTTP framing: a
 * blank line (CRLF + CRLF) is reduced to `????` by the same transcoder
 * that maps single CRLF to `??`.
 */
const HTTP_BODY_SEPARATOR = '????';

/**
 * Classify a string for known lossy-mangling shapes. Pure, O(n), no
 * I/O. Returns `{ kind: 'none' }` when nothing matches; callers should
 * treat `'none'` as "render the raw value as-is".
 */
export function detectLossyMangling(value: string): LossyManglingDetection {
  if (!value.includes('??')) return { kind: 'none' };
  const matches = value.match(HTTP_HEADER_SHAPE_RE);
  if (matches === null || matches.length < HTTP_FRAMING_MIN_HEADER_MATCHES) {
    return { kind: 'none' };
  }
  return { kind: 'httpFraming' };
}

/**
 * Decoder pair to {@link detectLossyMangling}. `kind === 'none'`
 * returns the input unchanged (idempotent for values where no shape
 * was detected). `kind === 'httpFraming'` returns a prefix-decoded
 * variant where `??` between header-shaped segments is replaced with
 * `\r\n` (canonical HTTP CRLF framing); the body (the portion after
 * the first `????`, or after the run of header-shaped segments ends
 * in the fallback case) is preserved verbatim, so any `??` inside
 * the body survives.
 *
 * The dialog preview's line-splitter (`/\r\n|\r|\n/`) handles both
 * CRLF and LF so the rendered output is visually identical regardless
 * of the byte form. The CRLF choice matters when Apply writes the
 * decoded value back into the JSON source (so any tool that later
 * round-trips the string through a real HTTP parser gets spec-canonical
 * framing).
 *
 * Worked example (HTTP response):
 *   in:  `200 OK??Pragma: no-cache??Expires: -1????{"body":"..."}`
 *   out: `200 OK\r\nPragma: no-cache\r\nExpires: -1\r\n\r\n{"body":"..."}`
 *
 * Worked example with `??` in the body:
 *   in:  `200 OK??Foo: a??Bar: b??Baz: c????GET /x?a??b=1`
 *   out: `200 OK\r\nFoo: a\r\nBar: b\r\nBaz: c\r\n\r\nGET /x?a??b=1`
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

  // Fallback: no `????` separator. Walk `??`-separated segments and
  // stop at the first non-header segment. Any tail is preserved
  // verbatim (re-joined with `??` so internal `??` survives).
  const segments = value.split('??');
  let lastHeaderIndex = 0;
  for (let i = 1; i < segments.length; i++) {
    if (HTTP_HEADER_NAME_RE.test(segments[i] ?? '')) {
      lastHeaderIndex = i;
    } else {
      break;
    }
  }
  if (lastHeaderIndex === 0) {
    // No header-shaped segments after the first one. Detector should
    // not have classified this as `httpFraming`, but be defensive.
    return value;
  }
  const head = segments.slice(0, lastHeaderIndex + 1).join('\r\n');
  const tail = segments.slice(lastHeaderIndex + 1).join('??');
  return tail.length > 0 ? head + '\r\n' + tail : head;
}
