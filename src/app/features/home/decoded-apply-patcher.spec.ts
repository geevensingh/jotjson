import { patchDecodedString } from './decoded-apply-patcher';

describe('patchDecodedString', () => {
  describe('httpFraming kind', () => {
    it('rewrites a mangled HTTP-framing string literal to CRLF-decoded form', () => {
      const text =
        '{\n  "responseDetails": "200 OK??Foo: a??Bar: b??Baz: c????body",\n  "keep": true\n}';

      const result = patchDecodedString(text, ['responseDetails'], 'httpFraming');

      expect(result.patched).toBe(
        '{\n  "responseDetails": "200 OK\\r\\nFoo: a\\r\\nBar: b\\r\\nBaz: c\\r\\n\\r\\nbody",\n  "keep": true\n}',
      );
      expect(result.replacementText).toBe(
        '"200 OK\\r\\nFoo: a\\r\\nBar: b\\r\\nBaz: c\\r\\n\\r\\nbody"',
      );
      expect(
        result.patched.substring(
          result.targetOffset,
          result.targetOffset + result.replacementText.length,
        ),
      ).toBe(result.replacementText);
    });

    it('preserves the BOM byte at offset 0 in BOM-prefixed source', () => {
      const text = '\uFEFF{"responseDetails":"200 OK??A: x??B: y??C: z????body"}';

      const result = patchDecodedString(text, ['responseDetails'], 'httpFraming');

      expect(result.patched.charCodeAt(0)).toBe(0xfeff);
      expect(result.patched).toBe(
        '\uFEFF{"responseDetails":"200 OK\\r\\nA: x\\r\\nB: y\\r\\nC: z\\r\\n\\r\\nbody"}',
      );
    });

    it('preserves comments adjacent to the target literal byte-for-byte', () => {
      const text =
        '{\n  /* before */ "responseDetails": /* mid */ "200 OK??A: 1??B: 2??C: 3????body" /* after */\n}';

      const result = patchDecodedString(text, ['responseDetails'], 'httpFraming');

      expect(result.patched).toContain('/* before */');
      expect(result.patched).toContain('/* mid */');
      expect(result.patched).toContain('/* after */');
      expect(result.patched).toContain('"200 OK\\r\\nA: 1\\r\\nB: 2\\r\\nC: 3\\r\\n\\r\\nbody"');
    });

    it('rewrites a deep value in an array', () => {
      const text = '{"events":[{"detail":"200 OK??A: 1??B: 2??C: 3????body"}]}';

      const result = patchDecodedString(text, ['events', 0, 'detail'], 'httpFraming');

      expect(result.patched).toBe(
        '{"events":[{"detail":"200 OK\\r\\nA: 1\\r\\nB: 2\\r\\nC: 3\\r\\n\\r\\nbody"}]}',
      );
    });

    it('preserves embedded ?? in the body verbatim through the round-trip', () => {
      const text = '{"r":"200 OK??Foo: a??Bar: b??Baz: c????GET /x?token=abc??ver=1"}';

      const result = patchDecodedString(text, ['r'], 'httpFraming');

      expect(result.patched).toBe(
        '{"r":"200 OK\\r\\nFoo: a\\r\\nBar: b\\r\\nBaz: c\\r\\n\\r\\nGET /x?token=abc??ver=1"}',
      );
    });
  });

  describe('kind="none" idempotency', () => {
    it('returns the source unchanged when the target has no mangling and kind is none', () => {
      const text = '{"plain":"hello world"}';

      const result = patchDecodedString(text, ['plain'], 'none');

      expect(result.patched).toBe(text);
      expect(result.replacementText).toBe('"hello world"');
    });

    it('still rewrites the literal (re-serializing) even when no change is needed', () => {
      // JSON.stringify normalizes the literal (e.g. removes redundant
      // escapes). The function never short-circuits at the patcher
      // level - idempotency is enforced structurally upstream by the
      // detection visibility gate, not by the patcher.
      const text = '{"plain":"hello"}';

      const result = patchDecodedString(text, ['plain'], 'none');

      expect(result.targetLength).toBe('"hello"'.length);
      expect(result.replacementText).toBe('"hello"');
    });
  });

  describe('failure modes', () => {
    it('throws decoded.apply.parse-failed on malformed JSON', () => {
      expect(() => patchDecodedString('{"payload": ', ['payload'], 'httpFraming')).toThrowError(
        'decoded.apply.parse-failed',
      );
    });

    it('throws decoded.apply.path-not-found when the path does not exist', () => {
      expect(() =>
        patchDecodedString('{"payload":"foo"}', ['missing'], 'httpFraming'),
      ).toThrowError('decoded.apply.path-not-found');
    });

    it('throws decoded.apply.not-string when the target is not a string', () => {
      expect(() => patchDecodedString('{"payload":42}', ['payload'], 'httpFraming')).toThrowError(
        'decoded.apply.not-string',
      );

      expect(() =>
        patchDecodedString('{"payload":{"nested":1}}', ['payload'], 'httpFraming'),
      ).toThrowError('decoded.apply.not-string');

      expect(() =>
        patchDecodedString('{"payload":[1,2,3]}', ['payload'], 'httpFraming'),
      ).toThrowError('decoded.apply.not-string');
    });
  });
});
