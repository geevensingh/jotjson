import {
  BINARY_MAGIC_CATALOG,
  containsNulChar,
  decodeWithBom,
  detectBinary,
  detectEncoding,
  hasHighNonPrintableRatio,
  matchesBinaryMagic
} from './binary-detection';

function bytesFrom(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf16LeBytes(text: string): Uint8Array {
  const buffer = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    buffer[index * 2] = code & 0xff;
    buffer[index * 2 + 1] = (code >> 8) & 0xff;
  }
  return buffer;
}

function utf16BeBytes(text: string): Uint8Array {
  const buffer = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    buffer[index * 2] = (code >> 8) & 0xff;
    buffer[index * 2 + 1] = code & 0xff;
  }
  return buffer;
}

function withPrefix(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix, 0);
  combined.set(body, prefix.length);
  return combined;
}

const UTF8_BOM = bytesFrom(0xef, 0xbb, 0xbf);
const UTF16LE_BOM = bytesFrom(0xff, 0xfe);
const UTF16BE_BOM = bytesFrom(0xfe, 0xff);

describe('binary-detection / matchesBinaryMagic', () => {
  it('detects PNG signature', () => {
    expect(
      matchesBinaryMagic(bytesFrom(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00))
    ).toBe(true);
  });

  it('detects JPEG signature', () => {
    expect(matchesBinaryMagic(bytesFrom(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe(true);
  });

  it('detects GIF87a and GIF89a', () => {
    expect(matchesBinaryMagic(utf8Bytes('GIF87a...'))).toBe(true);
    expect(matchesBinaryMagic(utf8Bytes('GIF89a...'))).toBe(true);
  });

  it('detects WebP (RIFF + WEBP marker at offset 8)', () => {
    const webp = withPrefix(
      bytesFrom(0x52, 0x49, 0x46, 0x46, 0xaa, 0xbb, 0xcc, 0xdd),
      bytesFrom(0x57, 0x45, 0x42, 0x50, 0x00)
    );
    expect(matchesBinaryMagic(webp)).toBe(true);
  });

  it('detects WAV (RIFF + WAVE marker at offset 8)', () => {
    const wav = withPrefix(
      bytesFrom(0x52, 0x49, 0x46, 0x46, 0xaa, 0xbb, 0xcc, 0xdd),
      bytesFrom(0x57, 0x41, 0x56, 0x45, 0x00)
    );
    expect(matchesBinaryMagic(wav)).toBe(true);
  });

  it('does NOT match a RIFF prefix without WEBP/WAVE marker', () => {
    const rifflike = withPrefix(
      bytesFrom(0x52, 0x49, 0x46, 0x46, 0xaa, 0xbb, 0xcc, 0xdd),
      bytesFrom(0x4a, 0x55, 0x4e, 0x4b, 0x00)
    );
    expect(matchesBinaryMagic(rifflike)).toBe(false);
  });

  it('detects PDF "%PDF-"', () => {
    expect(matchesBinaryMagic(utf8Bytes('%PDF-1.7\n...'))).toBe(true);
  });

  it('detects ZIP local file header', () => {
    expect(matchesBinaryMagic(bytesFrom(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe(true);
  });

  it('detects GZIP', () => {
    expect(matchesBinaryMagic(bytesFrom(0x1f, 0x8b, 0x08, 0x00))).toBe(true);
  });

  it('detects 7z', () => {
    expect(matchesBinaryMagic(bytesFrom(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00))).toBe(true);
  });

  it('detects RAR', () => {
    expect(matchesBinaryMagic(bytesFrom(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00))).toBe(true);
  });

  it('detects TAR USTAR at offset 257 only', () => {
    const tarBuffer = new Uint8Array(512);
    tarBuffer.set(bytesFrom(0x75, 0x73, 0x74, 0x61, 0x72), 257);
    expect(matchesBinaryMagic(tarBuffer)).toBe(true);
  });

  it('does NOT match TAR USTAR at offset 0', () => {
    const offsetZero = new Uint8Array(512);
    offsetZero.set(bytesFrom(0x75, 0x73, 0x74, 0x61, 0x72), 0);
    expect(matchesBinaryMagic(offsetZero)).toBe(false);
  });

  it('detects ELF', () => {
    expect(matchesBinaryMagic(bytesFrom(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01))).toBe(true);
  });

  it('detects Mach-O 64-bit BE (FE ED FA CF)', () => {
    expect(matchesBinaryMagic(bytesFrom(0xfe, 0xed, 0xfa, 0xcf, 0x00, 0x00))).toBe(true);
  });

  it('detects SQLite database file', () => {
    expect(matchesBinaryMagic(utf8Bytes('SQLite format 3\u0000...'))).toBe(true);
  });

  it('detects JVM class file', () => {
    expect(matchesBinaryMagic(bytesFrom(0xca, 0xfe, 0xba, 0xbe, 0x00))).toBe(true);
  });

  it('detects legacy Office OLE/CFBF compound file', () => {
    expect(
      matchesBinaryMagic(bytesFrom(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00))
    ).toBe(true);
  });

  it('detects ISOBMFF/MP4 by "ftyp" at offset 4', () => {
    const mp4 = withPrefix(
      bytesFrom(0x00, 0x00, 0x00, 0x20),
      bytesFrom(0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d)
    );
    expect(matchesBinaryMagic(mp4)).toBe(true);
  });

  it('does NOT match plain JSON text', () => {
    expect(matchesBinaryMagic(utf8Bytes('{"a":1,"b":[true,false,null]}'))).toBe(false);
  });

  it('does NOT match short ASCII like "abcd"', () => {
    expect(matchesBinaryMagic(utf8Bytes('abcd'))).toBe(false);
  });

  it('does NOT match an empty buffer', () => {
    expect(matchesBinaryMagic(new Uint8Array(0))).toBe(false);
  });

  it('does NOT match common weak ASCII signatures we deliberately exclude (BMP "BM", PE "MZ", "ID3")', () => {
    expect(matchesBinaryMagic(utf8Bytes('BM is a fine prose opener'))).toBe(false);
    expect(matchesBinaryMagic(utf8Bytes('MZ: invalid headers received'))).toBe(false);
    expect(matchesBinaryMagic(utf8Bytes('ID3 tags lookup failed'))).toBe(false);
  });

  it('exposes a readable BINARY_MAGIC_CATALOG with entries the tests reference by name', () => {
    const names = BINARY_MAGIC_CATALOG.map((s) => s.name);
    expect(names).toContain('png');
    expect(names).toContain('pdf');
    expect(names).toContain('tar');
    expect(names).toContain('oleCfbf');
  });
});

describe('binary-detection / detectEncoding + decodeWithBom', () => {
  it('detects UTF-8 by default when no BOM is present', () => {
    expect(detectEncoding(utf8Bytes('hello'))).toBe('utf-8');
  });

  it('detects UTF-8 BOM (EF BB BF)', () => {
    expect(detectEncoding(withPrefix(UTF8_BOM, utf8Bytes('hello')))).toBe('utf-8');
  });

  it('detects UTF-16 LE BOM (FF FE)', () => {
    expect(detectEncoding(withPrefix(UTF16LE_BOM, utf16LeBytes('hello')))).toBe('utf-16le');
  });

  it('detects UTF-16 BE BOM (FE FF)', () => {
    expect(detectEncoding(withPrefix(UTF16BE_BOM, utf16BeBytes('hello')))).toBe('utf-16be');
  });

  it('decodeWithBom returns the original text and reported encoding for plain UTF-8', () => {
    const result = decodeWithBom(utf8Bytes('plain text'));
    expect(result).toEqual({ text: 'plain text', encoding: 'utf-8' });
  });

  it('decodeWithBom strips a leading UTF-8 BOM from the returned text', () => {
    const buffer = withPrefix(UTF8_BOM, utf8Bytes('hello world'));
    const result = decodeWithBom(buffer);
    expect(result.text).toBe('hello world');
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.encoding).toBe('utf-8');
  });

  it('decodeWithBom decodes UTF-16 LE with BOM and returns no leading U+FEFF', () => {
    const buffer = withPrefix(UTF16LE_BOM, utf16LeBytes('hi there'));
    const result = decodeWithBom(buffer);
    expect(result.text).toBe('hi there');
    expect(result.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(result.encoding).toBe('utf-16le');
  });

  it('decodeWithBom decodes UTF-16 BE with BOM correctly', () => {
    const buffer = withPrefix(UTF16BE_BOM, utf16BeBytes('big endian'));
    const result = decodeWithBom(buffer);
    expect(result.text).toBe('big endian');
    expect(result.encoding).toBe('utf-16be');
  });

  it('decodeWithBom with an empty buffer returns empty UTF-8 text', () => {
    const result = decodeWithBom(new Uint8Array(0));
    expect(result).toEqual({ text: '', encoding: 'utf-8' });
  });
});

describe('binary-detection / containsNulChar', () => {
  it('returns false for plain text', () => {
    expect(containsNulChar('hello world')).toBe(false);
  });

  it('returns true for an embedded NUL character', () => {
    expect(containsNulChar('hello\u0000world')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(containsNulChar('')).toBe(false);
  });
});

describe('binary-detection / hasHighNonPrintableRatio', () => {
  it('returns false for plain text with whitespace', () => {
    expect(hasHighNonPrintableRatio('hello\nworld\t!\r\n')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(hasHighNonPrintableRatio('')).toBe(false);
  });

  it('counts U+FFFD (replacement char) as non-printable', () => {
    expect(hasHighNonPrintableRatio('\uFFFD\uFFFD\uFFFDab')).toBe(true);
  });

  it('counts C0 control chars as non-printable but tolerates tab/LF/VT/FF/CR', () => {
    expect(hasHighNonPrintableRatio('\u0001\u0002\u0003\u0004ab')).toBe(true);
    expect(hasHighNonPrintableRatio('\t\n\v\f\r abcdefgh')).toBe(false);
  });

  it('counts C1 control chars (U+0080 - U+009F) as non-printable', () => {
    expect(hasHighNonPrintableRatio('\u0080\u0081\u0082\u0083ab')).toBe(true);
  });

  it('returns false at exactly 30% (strict greater-than threshold)', () => {
    expect(hasHighNonPrintableRatio('\u0001\u0002\u0003abcdef0')).toBe(false);
  });

  it('returns true above 30%', () => {
    expect(hasHighNonPrintableRatio('\u0001\u0002\u0003\u0004abcdef')).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(hasHighNonPrintableRatio('\u0001abcd', 0.1)).toBe(true);
    expect(hasHighNonPrintableRatio('\u0001abcd', 0.5)).toBe(false);
  });
});

describe('binary-detection / detectBinary integration', () => {
  it('rejects PNG with reason "magic"', () => {
    const buffer = bytesFrom(
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    );
    expect(detectBinary(buffer)).toEqual({ isBinary: true, reason: 'magic' });
  });

  it('rejects PDF with reason "magic"', () => {
    expect(detectBinary(utf8Bytes('%PDF-1.7\nbody...'))).toEqual({
      isBinary: true,
      reason: 'magic'
    });
  });

  it('rejects ZIP with reason "magic"', () => {
    expect(detectBinary(bytesFrom(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00))).toEqual({
      isBinary: true,
      reason: 'magic'
    });
  });

  it('rejects magic bytes followed by valid-looking JSON (magic wins)', () => {
    const buffer = withPrefix(
      bytesFrom(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      utf8Bytes('{"a":1}')
    );
    expect(detectBinary(buffer)).toEqual({ isBinary: true, reason: 'magic' });
  });

  it('passes plain UTF-8 JSON', () => {
    const result = detectBinary(utf8Bytes('{"a":1,"b":[true,false,null]}'));
    expect(result).toEqual({
      isBinary: false,
      text: '{"a":1,"b":[true,false,null]}',
      encoding: 'utf-8'
    });
  });

  it('passes UTF-8 with BOM and returns text without the BOM character', () => {
    const buffer = withPrefix(UTF8_BOM, utf8Bytes('{"a":1}'));
    const result = detectBinary(buffer);
    expect(result).toEqual({ isBinary: false, text: '{"a":1}', encoding: 'utf-8' });
  });

  it('passes UTF-16 LE with BOM (no false NUL hit on alternating bytes)', () => {
    const buffer = withPrefix(UTF16LE_BOM, utf16LeBytes('{"a":1}'));
    const result = detectBinary(buffer);
    expect(result).toEqual({ isBinary: false, text: '{"a":1}', encoding: 'utf-16le' });
  });

  it('passes UTF-16 BE with BOM', () => {
    const buffer = withPrefix(UTF16BE_BOM, utf16BeBytes('{"x":42}'));
    const result = detectBinary(buffer);
    expect(result).toEqual({ isBinary: false, text: '{"x":42}', encoding: 'utf-16be' });
  });

  it('rejects text with an embedded NUL character ("nul" reason)', () => {
    expect(detectBinary(utf8Bytes('hello\u0000world'))).toEqual({
      isBinary: true,
      reason: 'nul'
    });
  });

  it('rejects mostly-binary input with no magic match via "ratio"', () => {
    const noisy = new Uint8Array(200);
    for (let index = 0; index < 100; index++) noisy[index] = 0x01;
    for (let index = 100; index < 200; index++) noisy[index] = 0x41;
    expect(detectBinary(noisy)).toEqual({ isBinary: true, reason: 'ratio' });
  });

  it('passes a multi-line log with embedded JSON (the M7p case)', () => {
    const log = 'INFO 2025-01-01 request received\n{"id":1,"ok":true}\nINFO done';
    const result = detectBinary(utf8Bytes(log));
    expect(result.isBinary).toBe(false);
    if (!result.isBinary) {
      expect(result.text).toBe(log);
      expect(result.encoding).toBe('utf-8');
    }
  });

  it('passes a JSON value containing a base64-encoded string payload', () => {
    const json = '{"data":"SGVsbG8sIFdvcmxkIQ=="}';
    const result = detectBinary(utf8Bytes(json));
    expect(result.isBinary).toBe(false);
  });

  it('passes a 5 MB ASCII buffer (no perceptible cost)', () => {
    const fiveMib = 5 * 1024 * 1024;
    const buffer = new Uint8Array(fiveMib);
    buffer.fill(0x41);
    const result = detectBinary(buffer);
    expect(result.isBinary).toBe(false);
  });

  it('passes a tiny 4-byte buffer of "abcd"', () => {
    expect(detectBinary(utf8Bytes('abcd'))).toEqual({
      isBinary: false,
      text: 'abcd',
      encoding: 'utf-8'
    });
  });

  it('passes an empty buffer (validator handles "empty" upstream, but this path is safe)', () => {
    expect(detectBinary(new Uint8Array(0))).toEqual({
      isBinary: false,
      text: '',
      encoding: 'utf-8'
    });
  });
});
