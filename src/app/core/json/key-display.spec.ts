import { pathToString } from './json-path';
import { displayKey } from './key-display';

describe('displayKey', () => {
  describe('core transforms (per ECMA-262 25.5.2 QuoteJSONString)', () => {
    it('returns a bare key unchanged', () => {
      expect(displayKey('foo')).toBe('foo');
    });

    it('escapes a real line feed as \\n', () => {
      expect(displayKey('a\nb')).toBe('a\\nb');
    });

    it('escapes a real CR+LF as \\r\\n', () => {
      expect(displayKey('a\r\nb')).toBe('a\\r\\nb');
    });

    it('escapes a real tab as \\t', () => {
      expect(displayKey('a\tb')).toBe('a\\tb');
    });

    it('escapes a real backspace as \\b', () => {
      expect(displayKey('a\bb')).toBe('a\\bb');
    });

    it('escapes a real form feed as \\f', () => {
      expect(displayKey('a\fb')).toBe('a\\fb');
    });

    it('escapes an embedded double quote as \\"', () => {
      expect(displayKey('a"b')).toBe('a\\"b');
    });

    it('escapes a single backslash as \\\\', () => {
      expect(displayKey('a\\b')).toBe('a\\\\b');
    });

    it('escapes a C0 control as \\uXXXX with lowercase hex', () => {
      expect(displayKey('\u0001')).toBe('\\u0001');
    });

    it('returns an empty string for an empty key', () => {
      expect(displayKey('')).toBe('');
    });
  });

  describe('lone surrogates (ES2019 Well-Formed JSON.stringify)', () => {
    it('escapes a lone high surrogate as lowercase \\uHHHH', () => {
      expect(displayKey('\uD800')).toBe('\\ud800');
    });

    it('escapes a lone low surrogate as lowercase \\uHHHH', () => {
      expect(displayKey('\uDC00')).toBe('\\udc00');
    });
  });

  describe('known-limit pass-through (documented in DESIGN_SPEC.md)', () => {
    it('passes DEL (U+007F) through unchanged', () => {
      expect(displayKey('\u007F')).toBe('\u007F');
    });

    it('passes C1 NEL (U+0085) through unchanged', () => {
      expect(displayKey('\u0085')).toBe('\u0085');
    });

    it('passes U+2028 LINE SEPARATOR through unchanged', () => {
      expect(displayKey('a\u2028b')).toBe('a\u2028b');
    });

    it('passes a paired-surrogate astral emoji through unchanged', () => {
      expect(displayKey('\u{1F600}')).toBe('\u{1F600}');
    });
  });

  describe('lock-step equivalence with pathToString', () => {
    // The cross-helper invariant: both helpers JSON-escape keys via the
    // same `JSON.stringify` transform. If either widens unilaterally,
    // copy-path output silently diverges from inline rendering. These
    // parameterized specs pin the equivalence so future drift fails
    // CI loudly. See JSDoc on `displayKey` and `pathToString` for
    // detail.

    // Bare-safe fixtures (match /^[A-Za-z_$][\w$]*$/): pathToString
    // emits dot form and displayKey returns identity.
    const bareSafeFixtures = ['foo', 'bar', '_x', '$x', 'a1'];
    for (const key of bareSafeFixtures) {
      it(`bare-safe '${key}': pathToString uses dot form and displayKey is identity`, () => {
        expect(pathToString(['x', key])).toBe(`$.x.${key}`);
        expect(displayKey(key)).toBe(key);
      });
    }

    // Non-bare fixtures: pathToString must contain '"' + displayKey + '"'
    // as a substring. Substring-contains is the load-bearing form; it
    // correctly flips when either helper widens its escape set.
    const nonBareFixtures = [
      'a\nb',
      'a\r\nb',
      'a\tb',
      'a"b',
      'a\\b',
      '\u0001',
      '',
      'with space',
      '123starts-numeric',
    ];
    for (const key of nonBareFixtures) {
      it(`non-bare ${JSON.stringify(key)}: pathToString contains '"' + displayKey + '"'`, () => {
        expect(pathToString(['x', key])).toContain(`"${displayKey(key)}"`);
      });
    }
  });
});
