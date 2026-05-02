import { TestBed } from '@angular/core/testing';
import { TitleSuggesterService } from './title-suggester.service';
import type { SuggestionInput } from './types';

function inputFor(jsonText: string, filename: string | null = null): SuggestionInput {
  let parsed: unknown = undefined;
  let hasParseErrors = false;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    hasParseErrors = true;
  }
  return { jsonText, parsed, hasParseErrors, filename };
}

describe('TitleSuggesterService', () => {
  let service: TitleSuggesterService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TitleSuggesterService);
  });

  describe('empty input', () => {
    it('returns [] for empty string', () => {
      expect(service.suggest(inputFor(''))).toEqual([]);
    });

    it('returns [] for whitespace-only string', () => {
      expect(service.suggest(inputFor('   \n\t  '))).toEqual([]);
    });
  });

  describe('cap and ordering', () => {
    it('caps the result at 7 candidates', () => {
      const json = JSON.stringify({
        name: 'A',
        title: 'B',
        displayName: 'C',
        subject: 'D',
        label: 'E',
        '@type': 'F',
        description: 'G is a thing',
        summary: 'H is a thing',
      });
      const result = service.suggest(inputFor(json));
      expect(result.length).toBeLessThanOrEqual(7);
    });

    it('orders strategies by confidence descending', () => {
      const result = service.suggest(inputFor('{"name":"alice"}', 'config.json'));
      // filename (95) > namedField (75)
      expect(result[0]?.source).toBe('filename');
      expect(result[1]?.source).toBe('namedField');
    });

    it('truncates values to 200 chars', () => {
      const longName = 'a'.repeat(300);
      const result = service.suggest(inputFor(`{"name":"${longName}"}`));
      const namedFieldEntry = result.find((c) => c.source === 'namedField');
      expect(namedFieldEntry?.value.length).toBe(200);
    });
  });

  describe('dedupe', () => {
    it('collapses case-insensitive duplicates and keeps the higher-confidence entry', () => {
      // filename "alice" and namedField "Alice" should collapse, keep filename.
      const result = service.suggest(inputFor('{"name":"Alice"}', 'alice.json'));
      const matching = result.filter((c) => c.value.toLowerCase().trim() === 'alice');
      expect(matching.length).toBe(1);
      expect(matching[0]?.source).toBe('filename');
    });
  });

  describe('synthetic floor', () => {
    it('returns >=2 candidates for representative real-world payloads', () => {
      const cases = [
        '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"nginx"}}',
        '{"name":"jotjson","scripts":{}}',
        '{"openapi":"3.0.0","info":{"title":"Petstore","version":"1.0"}}',
        '{"foo":"bar","baz":1}',
        '[{"id":1},{"id":2}]',
      ];
      for (const json of cases) {
        const result = service.suggest(inputFor(json));
        expect(result.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('returns >=2 for unparseable JSON via firstChars + untitled', () => {
      const result = service.suggest(inputFor('not valid json {{{'));
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some((c) => c.source === 'firstChars')).toBe(true);
      expect(result.some((c) => c.source === 'untitled')).toBe(true);
    });

    it('appends dateStamped fallback when firstChars and untitled collide', () => {
      // User pasted exactly "Untitled" (a string literal). The parsed
      // value is the JS string "Untitled". `primitive` would fire as
      // 'String: Untitled', `firstChars` as the raw "\"Untitled\""
      // (incl. quotes), `untitled` as "Untitled". After dedupe none
      // collide. So pick a different test.
      const result = service.suggest(inputFor('Untitled'));
      // 'Untitled' is unparseable as JSON, so primitive doesn't fire.
      // firstChars = "Untitled", untitled = "Untitled" -- they collide.
      const untitledEntries = result.filter((c) => c.value.toLowerCase().trim() === 'untitled');
      expect(untitledEntries.length).toBe(1);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // Synthetic floor should have appended a dateStamped or numbered.
      expect(
        result.some((c) => c.source === 'dateStamped' || c.source === 'numberedUntitled'),
      ).toBe(true);
    });
  });

  describe('parse errors', () => {
    it('still returns firstChars + untitled when parse fails', () => {
      const result = service.suggest(inputFor('{{{}}'));
      expect(result.some((c) => c.source === 'firstChars')).toBe(true);
      expect(result.some((c) => c.source === 'untitled')).toBe(true);
    });

    it('does not run shape-based strategies when parse fails', () => {
      const result = service.suggest(inputFor('{not json'));
      expect(result.some((c) => c.source === 'objectShape')).toBe(false);
      expect(result.some((c) => c.source === 'arrayShape')).toBe(false);
      expect(result.some((c) => c.source === 'primitive')).toBe(false);
    });
  });

  describe('filename strategy', () => {
    it('uses filename when set, with extension stripped', () => {
      const result = service.suggest(inputFor('{}', 'nginx-deployment.json'));
      const filenameEntry = result.find((c) => c.source === 'filename');
      expect(filenameEntry?.value).toBe('nginx-deployment');
    });

    it('skips when filename is null', () => {
      const result = service.suggest(inputFor('{"a":1}'));
      expect(result.find((c) => c.source === 'filename')).toBeUndefined();
    });

    it('strips path components', () => {
      const result = service.suggest(inputFor('{}', 'C:\\Users\\me\\Downloads\\my-config.json'));
      const filenameEntry = result.find((c) => c.source === 'filename');
      expect(filenameEntry?.value).toBe('my-config');
    });
  });

  describe('package.json strategy', () => {
    it('fires on filename match', () => {
      const result = service.suggest(inputFor('{"name":"foo","version":"1.0"}', 'package.json'));
      const entry = result.find((c) => c.source === 'packageJson');
      expect(entry?.value).toBe('foo@1.0');
    });

    it('fires when scripts marker is present', () => {
      const result = service.suggest(
        inputFor('{"name":"jotjson","version":"0.5.0","scripts":{"build":""}}'),
      );
      const entry = result.find((c) => c.source === 'packageJson');
      expect(entry?.value).toBe('jotjson@0.5.0');
    });

    it('does not fire on bare {name, version} without marker keys or matching filename', () => {
      const result = service.suggest(inputFor('{"name":"foo","version":"1.0"}', 'random.json'));
      expect(result.find((c) => c.source === 'packageJson')).toBeUndefined();
    });
  });

  describe('kubernetes strategy', () => {
    it('formats kind + metadata.name', () => {
      const result = service.suggest(
        inputFor('{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"nginx"}}'),
      );
      const entry = result.find((c) => c.source === 'kubernetes');
      expect(entry?.value).toBe('Deployment: nginx');
    });

    it('skips when metadata.name is missing', () => {
      const result = service.suggest(inputFor('{"apiVersion":"v1","kind":"Pod","metadata":{}}'));
      expect(result.find((c) => c.source === 'kubernetes')).toBeUndefined();
    });
  });

  describe('openapi strategy', () => {
    it('handles OpenAPI 3.x', () => {
      const result = service.suggest(
        inputFor('{"openapi":"3.0.0","info":{"title":"Petstore","version":"1.0"}}'),
      );
      const entry = result.find((c) => c.source === 'openapi');
      expect(entry?.value).toBe('Petstore v1.0');
    });

    it('handles Swagger 2.0', () => {
      const result = service.suggest(
        inputFor('{"swagger":"2.0","info":{"title":"My API","version":"v1"}}'),
      );
      const entry = result.find((c) => c.source === 'openapi');
      expect(entry?.value).toBe('My API vv1');
    });

    it('skips when info.title is missing', () => {
      const result = service.suggest(inputFor('{"openapi":"3.0.0","info":{"version":"1.0"}}'));
      expect(result.find((c) => c.source === 'openapi')).toBeUndefined();
    });
  });

  describe('selfUrl strategy', () => {
    it('handles selfUrl camelCase', () => {
      const result = service.suggest(
        inputFor('{"selfUrl":"https://api.example.com/v1/users/alice"}'),
      );
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('alice');
    });

    it('handles self_url snake_case', () => {
      const result = service.suggest(
        inputFor('{"self_url":"https://api.example.com/v1/orders/123"}'),
      );
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('123');
    });

    it('handles HAL _links.self.href', () => {
      const result = service.suggest(
        inputFor('{"_links":{"self":{"href":"https://api.example.com/v1/users/bob"}}}'),
      );
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('bob');
    });

    it('strips trailing .json extension', () => {
      const result = service.suggest(
        inputFor('{"selfUrl":"https://api.example.com/v1/users/alice.json"}'),
      );
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('alice');
    });

    it('handles trailing slash', () => {
      const result = service.suggest(inputFor('{"selfUrl":"https://api.example.com/v1/users/"}'));
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('users');
    });

    it('skips non-string values', () => {
      const result = service.suggest(inputFor('{"selfUrl":123}'));
      expect(result.find((c) => c.source === 'selfUrl')).toBeUndefined();
    });

    it('skips non-URL strings', () => {
      const result = service.suggest(inputFor('{"selfUrl":"not a url"}'));
      expect(result.find((c) => c.source === 'selfUrl')).toBeUndefined();
    });

    it('skips URLs without a usable path', () => {
      const result = service.suggest(inputFor('{"selfUrl":"https://example.com/"}'));
      expect(result.find((c) => c.source === 'selfUrl')).toBeUndefined();
    });

    it('prefers selfUrl over _links.self.href when both present', () => {
      const result = service.suggest(
        inputFor(
          '{"selfUrl":"https://api.example.com/v1/a/direct","_links":{"self":{"href":"https://api.example.com/v1/a/hal"}}}',
        ),
      );
      const entry = result.find((c) => c.source === 'selfUrl');
      expect(entry?.value).toBe('direct');
    });
  });

  describe('namedField strategy', () => {
    it('priority chain: name beats title', () => {
      const result = service.suggest(inputFor('{"name":"X","title":"Y"}'));
      const entry = result.find((c) => c.source === 'namedField');
      expect(entry?.value).toBe('X');
    });

    it('uses subject when name/title/displayName absent', () => {
      const result = service.suggest(inputFor('{"subject":"Re: meeting notes"}'));
      const entry = result.find((c) => c.source === 'namedField');
      expect(entry?.value).toBe('Re: meeting notes');
    });

    it('uses label when higher-priority absent', () => {
      const result = service.suggest(inputFor('{"label":"Production","id":"abc"}'));
      const entry = result.find((c) => c.source === 'namedField');
      expect(entry?.value).toBe('Production');
    });

    it('rejects UUID-shaped id', () => {
      const result = service.suggest(inputFor('{"id":"550e8400-e29b-41d4-a716-446655440000"}'));
      expect(result.find((c) => c.source === 'namedField')).toBeUndefined();
    });

    it('rejects pure-numeric slug', () => {
      const result = service.suggest(inputFor('{"slug":"12345"}'));
      expect(result.find((c) => c.source === 'namedField')).toBeUndefined();
    });

    it('accepts human-readable slug', () => {
      const result = service.suggest(inputFor('{"slug":"my-cool-blob"}'));
      const entry = result.find((c) => c.source === 'namedField');
      expect(entry?.value).toBe('my-cool-blob');
    });
  });

  describe('typeField strategy', () => {
    it('reads @type', () => {
      const result = service.suggest(inputFor('{"@type":"Person","name":"Alice"}'));
      // namedField wins display, but typeField should also fire.
      const entry = result.find((c) => c.source === 'typeField');
      expect(entry?.value).toBe('Person');
    });

    it('reads __typename', () => {
      const result = service.suggest(inputFor('{"__typename":"User"}'));
      const entry = result.find((c) => c.source === 'typeField');
      expect(entry?.value).toBe('User');
    });

    it('reads resourceType', () => {
      const result = service.suggest(inputFor('{"resourceType":"Patient"}'));
      const entry = result.find((c) => c.source === 'typeField');
      expect(entry?.value).toBe('Patient');
    });

    it('priority: @type beats __typename', () => {
      const result = service.suggest(inputFor('{"@type":"A","__typename":"B"}'));
      const entry = result.find((c) => c.source === 'typeField');
      expect(entry?.value).toBe('A');
    });

    it('skips non-string values', () => {
      const result = service.suggest(inputFor('{"__typename":42}'));
      expect(result.find((c) => c.source === 'typeField')).toBeUndefined();
    });
  });

  describe('descriptionFallback strategy', () => {
    it('takes first sentence from description', () => {
      const result = service.suggest(inputFor('{"description":"A short blurb. Second sentence."}'));
      const entry = result.find((c) => c.source === 'descriptionFallback');
      expect(entry?.value).toBe('A short blurb');
    });

    it('truncates long single sentences', () => {
      const long = 'word '.repeat(50);
      const result = service.suggest(inputFor(JSON.stringify({ description: long })));
      const entry = result.find((c) => c.source === 'descriptionFallback');
      expect(entry?.value.endsWith('...')).toBe(true);
      expect(entry?.value.length).toBeLessThanOrEqual(70);
    });

    it('falls back to summary when description absent', () => {
      const result = service.suggest(inputFor('{"summary":"A quick summary"}'));
      const entry = result.find((c) => c.source === 'descriptionFallback');
      expect(entry?.value).toBe('A quick summary');
    });

    it('prefers description over summary when both present', () => {
      const result = service.suggest(inputFor('{"description":"a","summary":"b"}'));
      const entry = result.find((c) => c.source === 'descriptionFallback');
      expect(entry?.value).toBe('a');
    });

    it('skips when both absent', () => {
      const result = service.suggest(inputFor('{"foo":"bar"}'));
      expect(result.find((c) => c.source === 'descriptionFallback')).toBeUndefined();
    });
  });

  describe('shape strategies', () => {
    it('fires arrayShape for arrays', () => {
      const result = service.suggest(inputFor('[1,2,3,4,5]'));
      const entry = result.find((c) => c.source === 'arrayShape');
      expect(entry?.value).toContain('5');
    });

    it('fires arrayShape "Empty list" for empty array', () => {
      const result = service.suggest(inputFor('[]'));
      const entry = result.find((c) => c.source === 'arrayShape');
      expect(entry?.value).toMatch(/Empty/i);
    });

    it('fires objectShape for non-empty object', () => {
      const result = service.suggest(inputFor('{"a":1,"b":2,"c":3}'));
      const entry = result.find((c) => c.source === 'objectShape');
      expect(entry?.value).toContain('3');
    });

    it('skips objectShape for empty object', () => {
      const result = service.suggest(inputFor('{}'));
      expect(result.find((c) => c.source === 'objectShape')).toBeUndefined();
    });

    it('fires primitive for top-level number', () => {
      const result = service.suggest(inputFor('42'));
      const entry = result.find((c) => c.source === 'primitive');
      expect(entry?.value).toContain('42');
    });

    it('fires primitive for top-level string', () => {
      const result = service.suggest(inputFor('"hello world"'));
      const entry = result.find((c) => c.source === 'primitive');
      expect(entry?.value).toContain('hello');
    });

    it('fires primitive for top-level null', () => {
      const result = service.suggest(inputFor('null'));
      const entry = result.find((c) => c.source === 'primitive');
      expect(entry?.value).toMatch(/null/i);
    });
  });
});
