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
      expect(svc.extractFromMixedText('', 2)).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(svc.extractFromMixedText('   \n\t  ', 2)).toBeNull();
    });

    it('returns null for pure prose with no braces', () => {
      expect(svc.extractFromMixedText('hello world', 2)).toBeNull();
    });

    it('returns null for a bare primitive number floating in prose', () => {
      expect(svc.extractFromMixedText('Total cost is 42 dollars', 2)).toBeNull();
    });

    it('returns null for a quoted string in prose (no { or [ trigger)', () => {
      expect(svc.extractFromMixedText('Status: "OK"', 2)).toBeNull();
    });

    it('returns null for an unbalanced { with no closing brace', () => {
      expect(svc.extractFromMixedText('prefix { "a": 1 suffix no closer', 2)).toBeNull();
    });

    it('returns null when input length exceeds 1 MiB', () => {
      const big = 'a'.repeat(1_048_577);
      expect(svc.extractFromMixedText(big, 2)).toBeNull();
    });
  });

  describe('single-block extraction', () => {
    it('extracts a single object surrounded by prose', () => {
      const r = svc.extractFromMixedText('before {"a":1} after', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['prefix']).toBe('before ');
      expect(wrapper['json']).toEqual({ a: 1 });
      expect(wrapper['suffix']).toBe(' after');
    });

    it('extracts a single array surrounded by prose', () => {
      const r = svc.extractFromMixedText('prefix [1,2,3] suffix', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['prefix']).toBe('prefix ');
      expect(wrapper['json']).toEqual([1, 2, 3]);
      expect(wrapper['suffix']).toBe(' suffix');
    });

    it('respects brace-balance when string contains a closing brace', () => {
      const r = svc.extractFromMixedText('prose {"a": "}"} prose', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['json']).toEqual({ a: '}' });
    });

    it('respects backslash-escaped quotes inside strings', () => {
      const r = svc.extractFromMixedText('{"a": "\\""}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      // No surrounding prose -> bare value
      expect(JSON.parse(r!.text)).toEqual({ a: '"' });
    });

    it('does not treat // inside a string as a comment (URL case)', () => {
      const r = svc.extractFromMixedText('{"url":"http://example.test/a//b"}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      // No surrounding prose -> bare value
      expect(JSON.parse(r!.text)).toEqual({
        url: 'http://example.test/a//b',
      });
    });

    it('does not treat /* */ inside a string as a comment', () => {
      const r = svc.extractFromMixedText('{"pattern":"/* not a comment */"}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      // No surrounding prose -> bare value
      expect(JSON.parse(r!.text)).toEqual({
        pattern: '/* not a comment */',
      });
    });

    it('does not extract JSON-looking text inside a string value', () => {
      const r = svc.extractFromMixedText('{"s":"{nested:1}"}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      // No surrounding prose -> bare value
      expect(JSON.parse(r!.text)).toEqual({ s: '{nested:1}' });
    });

    it('extracts JSON when prose contains a URL with // before the block', () => {
      const r = svc.extractFromMixedText('GET http://x.test {"ok":true}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['prefix']).toBe('GET http://x.test ');
      expect(wrapper['json']).toEqual({ ok: true });
    });

    it('preserves a leading BOM in the prose prefix', () => {
      const r = svc.extractFromMixedText('\uFEFFprefix {"a":1} suffix', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['prefix']).toBe('\uFEFFprefix ');
      expect(wrapper['json']).toEqual({ a: 1 });
      expect(wrapper['suffix']).toBe(' suffix');
    });
  });

  describe('JSONC comments inside a single block', () => {
    it('accepts and preserves a // line comment inside the block', () => {
      const r = svc.extractFromMixedText('{ // hello\n "a": 1 }', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      expect(r!.text).toContain('// hello');
    });

    it('accepts and preserves a /* */ block comment inside the block', () => {
      const r = svc.extractFromMixedText('{ /* hello */ "a": 1 }', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      expect(r!.text).toContain('/* hello */');
    });
  });

  describe('multi-block extraction', () => {
    it('wraps two objects with surrounding prose into a prose-preserving object', () => {
      const r = svc.extractFromMixedText('request {"a":1} response {"b":2}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(2);
      expect(r!.preservesComments).toBe(false);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['prefix']).toBe('request ');
      expect(wrapper['json1']).toEqual({ a: 1 });
      expect(wrapper['between_1_and_2']).toBe(' response ');
      expect(wrapper['json2']).toEqual({ b: 2 });
    });

    it('wraps three blocks of mixed shapes as a bare array when no prose surrounds them', () => {
      const r = svc.extractFromMixedText('{"a":1} [1,2] {"c":3}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(3);
      expect(r!.preservesComments).toBe(false);
      // Whitespace-only separators -> proseSegments === 0 -> bare array.
      expect(JSON.parse(r!.text)).toEqual([{ a: 1 }, [1, 2], { c: 3 }]);
    });

    it('drops malformed trailing block but keeps the leading valid block', () => {
      const r = svc.extractFromMixedText('{"a":1} prose {"b": ', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['json']).toEqual({ a: 1 });
      expect(wrapper['suffix']).toBe(' prose {"b": ');
    });
  });

  describe('failure recovery (start+1 resume)', () => {
    it('recovers a valid inner block from an invalid outer wrapper', () => {
      // The outer { notJson: ... } has an unquoted key and is invalid JSONC,
      // so the parser rejects it. The scanner must resume at start+1 (not
      // end+1) so the inner {"real":1} is still found. The rejected outer
      // text becomes prefix/suffix prose around the accepted inner block.
      const r = svc.extractFromMixedText('debug { notJson: {"real":1} } end', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      expect(r!.preservesComments).toBe(true);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['json']).toEqual({ real: 1 });
      expect(wrapper['prefix']).toBe('debug { notJson: ');
      expect(wrapper['suffix']).toBe(' } end');
    });
  });

  describe('hasComments detection', () => {
    it('reports hasComments: false for a single block with no comments', () => {
      const r = svc.extractFromMixedText('before {"a":1} after', 2);
      expect(r).not.toBeNull();
      expect(r!.hasComments).toBe(false);
    });

    it('reports hasComments: true for a single block with a // line comment', () => {
      const r = svc.extractFromMixedText('{ // hi\n "a": 1 }', 2);
      expect(r).not.toBeNull();
      expect(r!.hasComments).toBe(true);
    });

    it('reports hasComments: true for a single block with a /* */ block comment', () => {
      const r = svc.extractFromMixedText('{ /* hi */ "a": 1 }', 2);
      expect(r).not.toBeNull();
      expect(r!.hasComments).toBe(true);
    });

    it('does NOT count // inside a JSON string value as a comment', () => {
      const r = svc.extractFromMixedText('see {"url": "https://example.com/path"} done', 2);
      expect(r).not.toBeNull();
      expect(r!.hasComments).toBe(false);
    });

    it('does NOT count // in surrounding prose as a comment', () => {
      // The // appears in prose between the JSON candidate and end-of-string.
      // The outer scan loop only reacts to { and [, so prose // is invisible
      // to comment detection.
      const r = svc.extractFromMixedText('{"a":1} // not really a comment', 2);
      expect(r).not.toBeNull();
      expect(r!.hasComments).toBe(false);
    });

    it('reports hasComments: true when any multi-block candidate has comments', () => {
      const r = svc.extractFromMixedText('request {"a":1} response { /* trace */ "b": 2 }', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(2);
      expect(r!.hasComments).toBe(true);
    });

    it('reports hasComments: false when no multi-block candidate has comments', () => {
      const r = svc.extractFromMixedText('request {"a":1} response {"b":2}', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(2);
      expect(r!.hasComments).toBe(false);
    });

    it('LEAK GUARD: a failed outer wrapper containing a comment does not leak hasComments into the accepted inner block', () => {
      // Outer `{ notJson: ... }` contains a /* block comment */ and is
      // rejected by the parser (unquoted key). The scanner resumes at
      // start+1 and accepts the inner `{"real":1}`, which has no comments.
      // The rejected outer's comment must NOT propagate into the result.
      // The rejected outer text becomes the prose prefix/suffix.
      const r = svc.extractFromMixedText('log { /* nope */ notJson: {"real":1} } end', 2);
      expect(r).not.toBeNull();
      expect(r!.blockCount).toBe(1);
      const wrapper = JSON.parse(r!.text) as Record<string, unknown>;
      expect(wrapper['json']).toEqual({ real: 1 });
      expect(wrapper['prefix']).toBe('log { /* nope */ notJson: ');
      expect(wrapper['suffix']).toBe(' } end');
      expect(r!.hasComments, 'rejected outer wrapper must not leak its comment flag').toBe(false);
    });
  });

  // Issue #253: service threads its `tabSize` argument through to the
  // formatter. Spec-level coverage on the service ensures the public
  // signature stays honest end-to-end.
  describe('tabSize plumbing', () => {
    it('emits 4-space indent in the wrapper when tabSize is 4', () => {
      const r = svc.extractFromMixedText('before {"a":1} after', 4);
      expect(r).not.toBeNull();
      // 4-space indent on top-level wrapper keys.
      expect(r!.text).toContain('\n    "prefix"');
      expect(r!.text).toContain('\n    "json"');
      expect(r!.text).not.toMatch(/\n  "prefix"/);
    });

    it('emits 2-space indent in the wrapper when tabSize is 2', () => {
      const r = svc.extractFromMixedText('before {"a":1} after', 2);
      expect(r).not.toBeNull();
      expect(r!.text).toContain('\n  "prefix"');
      expect(r!.text).not.toContain('\n    "prefix"');
    });
  });
});
