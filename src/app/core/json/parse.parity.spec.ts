import { TestBed } from '@angular/core/testing';
import { JsonParserService } from './json-parser.service';
import { parse as pureParse, type JsonParseResult } from './parse';

/**
 * Parity spec: asserts the `JsonParserService` wrapper produces the
 * same `JsonParseResult` shape as the extracted pure `parse` function
 * for a representative corpus. This locks the service-to-pure
 * delegation in place so a future refactor cannot silently drift.
 *
 * The companion `parse.spec.ts` tests the pure surface in isolation.
 * The end-to-end behavioural coverage lives in
 * `json-parser.service.spec.ts`.
 */
const FIXTURES: {
  name: string;
  text: string;
  assertPureResult?: (result: JsonParseResult) => void;
  assertParity?: (fromService: JsonParseResult, fromPure: JsonParseResult) => void;
}[] = [
  { name: 'empty string', text: '' },
  { name: 'whitespace-only', text: '   \n\t ' },
  { name: 'BOM-prefixed', text: '\uFEFF{"a":1}' },
  { name: 'primitive null', text: 'null' },
  { name: 'primitive true', text: 'true' },
  { name: 'primitive number', text: '3.14' },
  { name: 'primitive string', text: '"abc"' },
  { name: 'flat object', text: '{"a":1,"b":"two","c":null}' },
  { name: 'nested object', text: '{"a":[1,2,{"b":true,"c":[null,"x"]}]}' },
  {
    name: 'JSONC: leading and trailing comments',
    text: `{
      // leading on a
      "a": 1, // trailing on a
      "b": 2
    }`,
  },
  {
    name: 'JSONC: block comment on close row',
    text: `{
      "a": 1
    } /* close trailing */`,
  },
  { name: 'JSONC: trailing comma in array', text: '[1, 2, 3,]' },
  { name: 'malformed: unclosed object', text: '{"a"' },
  { name: 'malformed: missing colon', text: '{"a" 1}' },
  { name: 'non-identifier key', text: '{"a.b":1,"0starts":2,"":3}' },
  {
    name: 'JSONC: stacked leading and closeLeading comments (issue #96)',
    text: `{
      // first leading
      // second leading
      "x": 1
      // first closeLeading
      // second closeLeading
    }`,
    assertParity: (fromService, fromPure) => {
      expect(fromPure.commentsByPath.size).toBe(fromService.commentsByPath.size);
      for (const [path, bundle] of fromPure.commentsByPath) {
        expect(fromService.commentsByPath.get(path)).toEqual(bundle);
      }
    },
    assertPureResult: (result) => {
      expect(result.commentsByPath.get('$.x')?.leading?.length).toBe(2);
      expect(result.commentsByPath.get('$')?.closeLeading?.length).toBe(2);
      expect(result.commentsByPath.get('$.x')?.leading).toEqual([
        'first leading',
        'second leading',
      ]);
      expect(result.commentsByPath.get('$')?.closeLeading).toEqual([
        'first closeLeading',
        'second closeLeading',
      ]);
    },
  },
];

function expectEquivalent(a: JsonParseResult, b: JsonParseResult): void {
  expect(a.empty).toBe(b.empty);
  expect(a.value).toEqual(b.value);
  expect(a.errors).toEqual(b.errors);
  expect(a.commentCount).toBe(b.commentCount);
  // The AST nodes themselves are reference-identical only when produced
  // by the same `parseTree` call, so compare structurally via Map size +
  // entries.
  expect(a.commentsByPath.size).toBe(b.commentsByPath.size);
  for (const [path, bundle] of a.commentsByPath) {
    expect(b.commentsByPath.get(path)).toEqual(bundle);
  }
}

describe('parse parity (service <-> pure)', () => {
  let service: JsonParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(JsonParserService);
  });

  for (const fixture of FIXTURES) {
    it(`matches for: ${fixture.name}`, () => {
      const fromService = service.parse(fixture.text);
      const fromPure = pureParse(fixture.text);
      expectEquivalent(fromService, fromPure);
      fixture.assertParity?.(fromService, fromPure);
      fixture.assertPureResult?.(fromPure);
    });
  }
});
