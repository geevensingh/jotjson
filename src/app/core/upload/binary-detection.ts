/**
 * Heuristic binary-vs-text detection for uploaded files.
 *
 * The waterfall (in order):
 *   1. Magic-byte sniff against a catalog of known binary signatures
 *      at fixed offsets (PNG, JPEG, PDF, ZIP, etc.).
 *   2. BOM-driven encoding detection plus TextDecoder decode (UTF-8,
 *      UTF-16 LE, UTF-16 BE).
 *   3. NUL-character scan on the decoded string.
 *   4. Non-printable code-point ratio on the decoded string.
 *
 * `file.type` (browser MIME) is **not** consulted - browser MIME on
 * drag-drop is unreliable, and content tiers are the source of
 * truth. See `DESIGN_SPEC.md` (file upload validation) and issue #62.
 */

const NON_PRINTABLE_RATIO_THRESHOLD = 0.3;

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

export type DetectionResult =
  | { readonly isBinary: true; readonly reason: 'magic' | 'nul' | 'ratio' }
  | {
      readonly isBinary: false;
      readonly text: string;
      readonly encoding: DetectedEncoding;
    };

interface MagicSignature {
  readonly name: string;
  readonly checks: ReadonlyArray<{
    readonly offset: number;
    readonly bytes: Uint8Array;
  }>;
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/**
 * Catalog of binary file signatures. Each entry's `checks` must all
 * match for the catalog entry to fire.
 *
 * Weak 2-3 byte ASCII signatures (BMP "BM", PE "MZ", MP3 "ID3") are
 * intentionally absent: they false-positive on real text. NUL-byte
 * and non-printable-ratio tiers catch their content.
 */
export const BINARY_MAGIC_CATALOG: readonly MagicSignature[] = [
  { name: 'png', checks: [{ offset: 0, bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) }] },
  { name: 'jpeg', checks: [{ offset: 0, bytes: bytes(0xff, 0xd8, 0xff) }] },
  { name: 'gif87a', checks: [{ offset: 0, bytes: bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) }] },
  { name: 'gif89a', checks: [{ offset: 0, bytes: bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61) }] },
  {
    name: 'webp',
    checks: [
      { offset: 0, bytes: bytes(0x52, 0x49, 0x46, 0x46) },
      { offset: 8, bytes: bytes(0x57, 0x45, 0x42, 0x50) }
    ]
  },
  {
    name: 'wav',
    checks: [
      { offset: 0, bytes: bytes(0x52, 0x49, 0x46, 0x46) },
      { offset: 8, bytes: bytes(0x57, 0x41, 0x56, 0x45) }
    ]
  },
  { name: 'tiffLe', checks: [{ offset: 0, bytes: bytes(0x49, 0x49, 0x2a, 0x00) }] },
  { name: 'tiffBe', checks: [{ offset: 0, bytes: bytes(0x4d, 0x4d, 0x00, 0x2a) }] },
  { name: 'ico', checks: [{ offset: 0, bytes: bytes(0x00, 0x00, 0x01, 0x00) }] },
  { name: 'pdf', checks: [{ offset: 0, bytes: bytes(0x25, 0x50, 0x44, 0x46, 0x2d) }] },
  { name: 'zipLocal', checks: [{ offset: 0, bytes: bytes(0x50, 0x4b, 0x03, 0x04) }] },
  { name: 'zipEmpty', checks: [{ offset: 0, bytes: bytes(0x50, 0x4b, 0x05, 0x06) }] },
  { name: 'zipSpanned', checks: [{ offset: 0, bytes: bytes(0x50, 0x4b, 0x07, 0x08) }] },
  { name: 'gzip', checks: [{ offset: 0, bytes: bytes(0x1f, 0x8b) }] },
  { name: 'bzip2', checks: [{ offset: 0, bytes: bytes(0x42, 0x5a, 0x68) }] },
  { name: 'sevenZip', checks: [{ offset: 0, bytes: bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) }] },
  { name: 'rar', checks: [{ offset: 0, bytes: bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07) }] },
  { name: 'tar', checks: [{ offset: 257, bytes: bytes(0x75, 0x73, 0x74, 0x61, 0x72) }] },
  { name: 'elf', checks: [{ offset: 0, bytes: bytes(0x7f, 0x45, 0x4c, 0x46) }] },
  { name: 'machO32Be', checks: [{ offset: 0, bytes: bytes(0xfe, 0xed, 0xfa, 0xce) }] },
  { name: 'machO64Be', checks: [{ offset: 0, bytes: bytes(0xfe, 0xed, 0xfa, 0xcf) }] },
  { name: 'machO32Le', checks: [{ offset: 0, bytes: bytes(0xce, 0xfa, 0xed, 0xfe) }] },
  { name: 'machO64Le', checks: [{ offset: 0, bytes: bytes(0xcf, 0xfa, 0xed, 0xfe) }] },
  { name: 'mp3SyncFb', checks: [{ offset: 0, bytes: bytes(0xff, 0xfb) }] },
  { name: 'mp3SyncF3', checks: [{ offset: 0, bytes: bytes(0xff, 0xf3) }] },
  { name: 'mp3SyncF2', checks: [{ offset: 0, bytes: bytes(0xff, 0xf2) }] },
  { name: 'isobmff', checks: [{ offset: 4, bytes: bytes(0x66, 0x74, 0x79, 0x70) }] },
  { name: 'ogg', checks: [{ offset: 0, bytes: bytes(0x4f, 0x67, 0x67, 0x53) }] },
  { name: 'flac', checks: [{ offset: 0, bytes: bytes(0x66, 0x4c, 0x61, 0x43) }] },
  {
    name: 'sqlite',
    checks: [
      {
        offset: 0,
        bytes: bytes(
          0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
          0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
        )
      }
    ]
  },
  { name: 'jvmClass', checks: [{ offset: 0, bytes: bytes(0xca, 0xfe, 0xba, 0xbe) }] },
  { name: 'oleCfbf', checks: [{ offset: 0, bytes: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1) }] }
];

function matchesAt(buffer: Uint8Array, offset: number, expected: Uint8Array): boolean {
  if (offset < 0 || offset + expected.length > buffer.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (buffer[offset + index] !== expected[index]) return false;
  }
  return true;
}

export function matchesBinaryMagic(buffer: Uint8Array): boolean {
  for (const signature of BINARY_MAGIC_CATALOG) {
    if (signature.checks.every((check) => matchesAt(buffer, check.offset, check.bytes))) {
      return true;
    }
  }
  return false;
}

export function detectEncoding(buffer: Uint8Array): DetectedEncoding {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf-8';
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le';
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return 'utf-16be';
  }
  return 'utf-8';
}

/**
 * Decode the buffer as text. The detected encoding (UTF-8, UTF-16
 * LE, or UTF-16 BE) is selected by leading BOM. UTF-32 is not
 * supported because browser TextDecoder cannot decode it. A leading
 * BOM is stripped by TextDecoder by default for both UTF-8 and
 * UTF-16, so the returned text never starts with U+FEFF.
 */
export function decodeWithBom(
  buffer: Uint8Array
): { text: string; encoding: DetectedEncoding } {
  const encoding = detectEncoding(buffer);
  const decoder = new TextDecoder(encoding, { fatal: false });
  const text = decoder.decode(buffer);
  return { text, encoding };
}

export function containsNulChar(text: string): boolean {
  return text.includes('\u0000');
}

function isNonPrintableCodePoint(codePoint: number): boolean {
  if (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d
  ) {
    return false;
  }
  if (codePoint >= 0x01 && codePoint <= 0x1f) return true;
  if (codePoint === 0x7f) return true;
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
  if (codePoint === 0xfffd) return true;
  return false;
}

export function hasHighNonPrintableRatio(
  text: string,
  threshold: number = NON_PRINTABLE_RATIO_THRESHOLD
): boolean {
  let nonPrintable = 0;
  let totalCodePoints = 0;
  for (const character of text) {
    totalCodePoints++;
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isNonPrintableCodePoint(codePoint)) {
      nonPrintable++;
    }
  }
  if (totalCodePoints === 0) return false;
  return nonPrintable / totalCodePoints > threshold;
}

/**
 * Top-level binary detection. Returns either `{isBinary: true,
 * reason}` or `{isBinary: false, text, encoding}` with the decoded
 * text ready for the caller to surface to the editor.
 */
export function detectBinary(buffer: Uint8Array): DetectionResult {
  if (matchesBinaryMagic(buffer)) {
    return { isBinary: true, reason: 'magic' };
  }
  const { text, encoding } = decodeWithBom(buffer);
  if (containsNulChar(text)) {
    return { isBinary: true, reason: 'nul' };
  }
  if (hasHighNonPrintableRatio(text)) {
    return { isBinary: true, reason: 'ratio' };
  }
  return { isBinary: false, text, encoding };
}
