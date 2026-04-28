import { TestBed } from '@angular/core/testing';
import { JsonExtractorService } from './json-extractor.service';

describe('JsonExtractorService', () => {
  let svc: JsonExtractorService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(JsonExtractorService);
  });

  describe('non-extracting inputs', () => {
    it('returns null for empty input', () => {
      expect(svc.extractFromMixedText('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(svc.extractFromMixedText('   \n\t  ')).toBeNull();
    });

    it('returns null for pure prose with no braces', () => {
      expect(svc.extractFromMixedText('hello world')).toBeNull();
    });

    it('returns null for a bare primitive number floating in prose', () => {
      expect(svc.extractFromMixedText('Total cost is 42 dollars')).toBeNull();
    });

    it('returns null for a quoted string in prose (no { or [ trigger)', () => {
      expect(svc.extractFromMixedText('Status: "OK"')).toBeNull();
    });

    it('returns null for an unbalanced { with no closing brace', () => {
      expect(
        svc.extractFromMixedText('prefix { "a": 1 suffix no closer')
      ).toBeNull();
    });

    it('returns null when input length exceeds 1 MiB', () => {
      const big = 'a'.repeat(1_048_577);
      expect(svc.extractFromMixedText(big)).toBeNull();
    });
  });

  describe('single-block extraction', () => {
    it('extracts a single object surrounded by prose', () => {
      const r = svc.extractFromMixedText('before {"a":1} after');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(JSON.parse(r!.text)).toEqual({ a: 1 });
    });

    it('extracts a single array surrounded by prose', () => {
      const r = svc.extractFromMixedText('prefix [1,2,3] suffix');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(JSON.parse(r!.text)).toEqual([1, 2, 3]);
    });

    it('respects brace-balance when string contains a closing brace', () => {
      const r = svc.extractFromMixedText('prose {"a": "}"} prose');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({ a: '}' });
    });

    it('respects backslash-escaped quotes inside strings', () => {
      const r = svc.extractFromMixedText('{"a": "\\""}');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({ a: '"' });
    });

    it('does not treat // inside a string as a comment (URL case)', () => {
      const r = svc.extractFromMixedText(
        '{"url":"http://example.test/a//b"}'
      );
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({
        url: 'http://example.test/a//b'
      });
    });

    it('does not treat /* */ inside a string as a comment', () => {
      const r = svc.extractFromMixedText(
        '{"pattern":"/* not a comment */"}'
      );
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({
        pattern: '/* not a comment */'
      });
    });

    it('does not extract JSON-looking text inside a string value', () => {
      const r = svc.extractFromMixedText('{"s":"{nested:1}"}');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({ s: '{nested:1}' });
    });

    it('extracts JSON when prose contains a URL with // before the block', () => {
      const r = svc.extractFromMixedText('GET http://x.test {"ok":true}');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({ ok: true });
    });

    it('strips a leading BOM before scanning', () => {
      const r = svc.extractFromMixedText('\uFEFFprefix {"a":1} suffix');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(JSON.parse(r!.text)).toEqual({ a: 1 });
    });
  });

  describe('JSONC comments inside a single block', () => {
    it('accepts and preserves a // line comment inside the block', () => {
      const r = svc.extractFromMixedText('{ // hello\n "a": 1 }');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(r!.text).toContain('// hello');
    });

    it('accepts and preserves a /* */ block comment inside the block', () => {
      const r = svc.extractFromMixedText('{ /* hello */ "a": 1 }');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(r!.text).toContain('/* hello */');
    });
  });

  describe('multi-block extraction', () => {
    it('wraps two objects as an array, in source order', () => {
      const r = svc.extractFromMixedText(
        'request {"a":1} response {"b":2}'
      );
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(2);
      expect(r!.preservesComments).toBeFalse();
      expect(JSON.parse(r!.text)).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('wraps three blocks of mixed shapes as an array', () => {
      const r = svc.extractFromMixedText('{"a":1} [1,2] {"c":3}');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(3);
      expect(r!.preservesComments).toBeFalse();
      expect(JSON.parse(r!.text)).toEqual([{ a: 1 }, [1, 2], { c: 3 }]);
    });

    it('drops malformed trailing block but keeps the leading valid block', () => {
      const r = svc.extractFromMixedText('{"a":1} prose {"b": ');
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(JSON.parse(r!.text)).toEqual({ a: 1 });
    });
  });

  describe('failure recovery (start+1 resume)', () => {
    it('recovers a valid inner block from an invalid outer wrapper', () => {
      // The outer { notJson: ... } has an unquoted key and is invalid JSONC,
      // so the parser rejects it. The scanner must resume at start+1 (not
      // end+1) so the inner {"real":1} is still found.
      const r = svc.extractFromMixedText(
        'debug { notJson: {"real":1} } end'
      );
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBeTrue();
      expect(JSON.parse(r!.text)).toEqual({ real: 1 });
    });
  });
});
