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

    it('handles null-prototype parsed inputs (#365 regression guard)', () => {
      // Production parser (`JsonParserService.parse`) returns
      // null-prototype objects after the #365 fix. `JSON.parse`
      // (used by `inputFor` above) returns plain-prototype
      // objects, so the existing tests do not exercise the
      // null-prototype path. Construct one directly and verify
      // the strategies (isPlainObject + Object.prototype.
      // hasOwnProperty.call) still work end-to-end.
      const parsed: Record<string, unknown> = Object.create(null);
      parsed['name'] = 'jotjson';
      parsed['version'] = '0.5.0';
      const scripts: Record<string, unknown> = Object.create(null);
      scripts['build'] = '';
      parsed['scripts'] = scripts;
      const result = service.suggest({
        jsonText: JSON.stringify(parsed),
        parsed,
        hasParseErrors: false,
        filename: null,
      });
      const entry = result.find((c) => c.source === 'packageJson');
      expect(entry?.value).toBe('jotjson@0.5.0');
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

  describe('identifierField strategy', () => {
    it('fires for invoiceId with a business-id-shaped value', () => {
      const result = service.suggest(inputFor('{"invoiceId":"G138888993"}'));
      const entry = result.find((c) => c.source === 'identifierField');
      expect(entry?.value).toBe('Invoice G138888993');
    });

    it('fires for orderId', () => {
      const result = service.suggest(inputFor('{"orderId":"ABC-123"}'));
      const entry = result.find((c) => c.source === 'identifierField');
      expect(entry?.value).toBe('Order ABC-123');
    });

    it('skips when invoiceId is a UUID', () => {
      const result = service.suggest(
        inputFor('{"invoiceId":"550e8400-e29b-41d4-a716-446655440000"}'),
      );
      expect(result.find((c) => c.source === 'identifierField')).toBeUndefined();
    });

    it('skips when invoiceId is pure-numeric (long)', () => {
      const result = service.suggest(inputFor('{"invoiceId":"6567005828"}'));
      expect(result.find((c) => c.source === 'identifierField')).toBeUndefined();
    });

    it('skips traceId and correlationId on purpose (privacy / noise)', () => {
      const trace = service.suggest(inputFor('{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"}'));
      expect(trace.find((c) => c.source === 'identifierField')).toBeUndefined();

      const correlation = service.suggest(
        inputFor('{"correlationId":"4bf92f3577b34da6a3ce929d0e0e4736"}'),
      );
      expect(correlation.find((c) => c.source === 'identifierField')).toBeUndefined();
    });

    it('priority: invoiceId beats orderId when both present', () => {
      const result = service.suggest(inputFor('{"orderId":"ORD-1","invoiceId":"INV-1"}'));
      const entry = result.find((c) => c.source === 'identifierField');
      expect(entry?.value).toBe('Invoice INV-1');
    });

    it('sorts above namedField (confidence 76 vs 75)', () => {
      const result = service.suggest(inputFor('{"invoiceId":"INV-1","name":"alice"}'));
      const identifierIdx = result.findIndex((c) => c.source === 'identifierField');
      const namedIdx = result.findIndex((c) => c.source === 'namedField');
      expect(identifierIdx).toBeGreaterThanOrEqual(0);
      expect(namedIdx).toBeGreaterThanOrEqual(0);
      expect(identifierIdx).toBeLessThan(namedIdx);
    });

    it('sorts below selfUrl (confidence 76 vs 77)', () => {
      const result = service.suggest(
        inputFor('{"invoiceId":"INV-1","selfUrl":"https://api.example.com/v1/invoices/INV-1"}'),
      );
      const selfUrlIdx = result.findIndex((c) => c.source === 'selfUrl');
      const identifierIdx = result.findIndex((c) => c.source === 'identifierField');
      expect(selfUrlIdx).toBeGreaterThanOrEqual(0);
      expect(identifierIdx).toBeGreaterThanOrEqual(0);
      expect(selfUrlIdx).toBeLessThan(identifierIdx);
    });
  });

  describe('cloudEvent strategy', () => {
    it('fires when all 4 required v1.0 attributes are present (source as URL)', () => {
      const result = service.suggest(
        inputFor(
          '{"specversion":"1.0","id":"abc","type":"com.example.someevent","source":"https://example.com/sensors/temperature01"}',
        ),
      );
      const entry = result.find((c) => c.source === 'cloudEvent');
      expect(entry?.value).toBe('com.example.someevent from temperature01');
    });

    it('falls back to type-only when source is not an http(s) URL', () => {
      const result = service.suggest(
        inputFor(
          '{"specversion":"1.0","id":"abc","type":"com.example.evt","source":"urn:example:foo"}',
        ),
      );
      const entry = result.find((c) => c.source === 'cloudEvent');
      expect(entry?.value).toBe('com.example.evt');
    });

    it('rejects near-miss: missing id (CloudEvents v1.0 requires id)', () => {
      const result = service.suggest(
        inputFor('{"specversion":"1.0","type":"com.example.evt","source":"https://example.com/a"}'),
      );
      expect(result.find((c) => c.source === 'cloudEvent')).toBeUndefined();
    });

    it('rejects near-miss: missing specversion', () => {
      const result = service.suggest(
        inputFor('{"id":"abc","type":"com.example.evt","source":"https://example.com/a"}'),
      );
      expect(result.find((c) => c.source === 'cloudEvent')).toBeUndefined();
    });
  });

  describe('jwtPayload strategy', () => {
    it('fires with human-friendly issuer when iss + 2 registered claims present', () => {
      const result = service.suggest(
        inputFor(
          '{"iss":"https://accounts.google.com","sub":"1234","aud":"client","exp":9999999999,"iat":1000000000}',
        ),
      );
      const entry = result.find((c) => c.source === 'jwtPayload');
      expect(entry?.value).toBe('JWT: https://accounts.google.com');
    });

    it('uses generic "JWT payload" when iss is long-hex (not human-friendly)', () => {
      const result = service.suggest(
        inputFor('{"iss":"abcdef0123456789abcdef0123456789","aud":"x","exp":9999999999}'),
      );
      const entry = result.find((c) => c.source === 'jwtPayload');
      expect(entry?.value).toBe('JWT payload');
    });

    it('rejects: iss alone is not enough (would over-fire on random objects)', () => {
      const result = service.suggest(inputFor('{"iss":"alice"}'));
      expect(result.find((c) => c.source === 'jwtPayload')).toBeUndefined();
    });

    it('rejects: iss + only 1 registered claim is too weak', () => {
      const result = service.suggest(inputFor('{"iss":"alice","exp":9999999999}'));
      expect(result.find((c) => c.source === 'jwtPayload')).toBeUndefined();
    });

    it('never uses sub as a fallback (privacy: sub is a principal id)', () => {
      const result = service.suggest(
        inputFor(
          '{"iss":"aaaaaaaaaaaaaaaa0000000000000000","sub":"alice@example.com","aud":"x","exp":9}',
        ),
      );
      const entry = result.find((c) => c.source === 'jwtPayload');
      expect(entry?.value).not.toContain('alice@example.com');
    });
  });

  describe('microsoftCommerceBillingEvent strategy', () => {
    it('fires on the 4-field envelope and composes verb + product', () => {
      const result = service.suggest(
        inputFor(
          '{"eventType":"chargeInvoiced","eventId":"abc","eventTimestamp":"2026-02-06T12:59:52Z","charge":{"product":"Microsoft 365 Business Basic"}}',
        ),
      );
      const entry = result.find((c) => c.source === 'microsoftCommerceBillingEvent');
      expect(entry?.value).toBe('Charge Invoiced -- Microsoft 365 Business Basic');
    });

    it('falls back to verb-only when charge.product is missing', () => {
      const result = service.suggest(
        inputFor(
          '{"eventType":"chargeInvoiced","eventId":"abc","eventTimestamp":"2026-02-06T12:59:52Z","charge":{}}',
        ),
      );
      const entry = result.find((c) => c.source === 'microsoftCommerceBillingEvent');
      expect(entry?.value).toBe('Charge Invoiced');
    });

    it('rejects near-miss: eventType + eventId without charge', () => {
      const result = service.suggest(
        inputFor(
          '{"eventType":"chargeInvoiced","eventId":"abc","eventTimestamp":"2026-02-06T12:59:52Z"}',
        ),
      );
      expect(result.find((c) => c.source === 'microsoftCommerceBillingEvent')).toBeUndefined();
    });
  });

  describe('applicationInsightsTelemetry strategy', () => {
    it('fires on EventTelemetry envelope and uses baseData.name', () => {
      const json = JSON.stringify({
        name: 'Microsoft.ApplicationInsights.Event',
        time: '2026-02-06T12:00:00Z',
        iKey: '00000000-0000-0000-0000-000000000000',
        tags: { 'ai.cloud.role': 'web' },
        data: { baseType: 'EventData', baseData: { name: 'UserSignedIn' } },
      });
      const result = service.suggest(inputFor(json));
      const entry = result.find((c) => c.source === 'applicationInsightsTelemetry');
      expect(entry?.value).toBe('EventData: UserSignedIn');
    });

    it('falls back to baseData.message for ExceptionTelemetry', () => {
      const json = JSON.stringify({
        name: 'Microsoft.ApplicationInsights.Exception',
        time: '2026-02-06T12:00:00Z',
        iKey: '00000000-0000-0000-0000-000000000000',
        tags: {},
        data: {
          baseType: 'ExceptionData',
          baseData: { message: 'TypeError: x is undefined' },
        },
      });
      const result = service.suggest(inputFor(json));
      const entry = result.find((c) => c.source === 'applicationInsightsTelemetry');
      expect(entry?.value).toBe('ExceptionData: TypeError: x is undefined');
    });

    it('rejects near-miss: missing data', () => {
      const json = JSON.stringify({
        name: 'Microsoft.ApplicationInsights.Event',
        time: '2026-02-06T12:00:00Z',
        iKey: '00000000-0000-0000-0000-000000000000',
        tags: {},
      });
      const result = service.suggest(inputFor(json));
      expect(result.find((c) => c.source === 'applicationInsightsTelemetry')).toBeUndefined();
    });
  });

  describe('eventEnvelope composite strategy', () => {
    it('fires on eventType + product', () => {
      const result = service.suggest(
        inputFor('{"eventType":"orderShipped","product":"Acme Widget"}'),
      );
      const entry = result.find((c) => c.source === 'eventEnvelope');
      expect(entry?.value).toBe('Order Shipped -- Acme Widget');
    });

    it('fires on action + resourceType', () => {
      const result = service.suggest(inputFor('{"action":"renew","resourceType":"Subscription"}'));
      const entry = result.find((c) => c.source === 'eventEnvelope');
      expect(entry?.value).toBe('Renew -- Subscription');
    });

    it('rejects when only one anchor is present', () => {
      const result = service.suggest(inputFor('{"eventType":"orderShipped"}'));
      expect(result.find((c) => c.source === 'eventEnvelope')).toBeUndefined();
    });

    it('rejects when second anchor is a pure-SKU machine token', () => {
      const result = service.suggest(inputFor('{"action":"renew","sku":"1D9-00001"}'));
      expect(result.find((c) => c.source === 'eventEnvelope')).toBeUndefined();
    });

    it('suppresses when cloudEvent would also fire', () => {
      const result = service.suggest(
        inputFor(
          '{"specversion":"1.0","id":"abc","type":"orderShipped","source":"https://x.example.com/a","product":"Acme Widget"}',
        ),
      );
      expect(result.find((c) => c.source === 'eventEnvelope')).toBeUndefined();
      expect(result.find((c) => c.source === 'cloudEvent')).toBeDefined();
    });

    it('suppresses when microsoftCommerceBillingEvent would also fire', () => {
      const result = service.suggest(
        inputFor(
          '{"eventType":"chargeInvoiced","eventId":"abc","eventTimestamp":"2026-02-06T12:59:52Z","charge":{"product":"Microsoft 365 Business Basic"},"product":"Microsoft 365 Business Basic"}',
        ),
      );
      expect(result.find((c) => c.source === 'eventEnvelope')).toBeUndefined();
    });
  });

  describe('humanize utilities (via strategies)', () => {
    it('countryName works for valid ISO-3166 alpha-2 (smoke test via Intl.DisplayNames)', () => {
      // The humanizers module is private to strategies/. Exercise it
      // indirectly: when CloudEvents fires with a source URL whose
      // host implies a country (we cannot easily smoke that), we
      // instead test countryName via a direct dynamic import to keep
      // coverage honest.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      return import('./strategies/humanize').then(({ countryName, verbalize }) => {
        expect(countryName('KW')).toBe('Kuwait');
        expect(countryName('US')).toBe('United States');
        // 'ZZ' is reserved by ISO-3166 and Intl.DisplayNames may
        // return either the raw code or "Unknown Region" depending
        // on engine + ICU data; we only require it not to throw.
        expect(typeof countryName('zz')).toBe('string');
        expect(countryName('')).toBe('');
        expect(countryName(undefined)).toBe('');
        expect(countryName('!!')).toBe('!!');
        expect(verbalize('chargeInvoiced')).toBe('Charge Invoiced');
        expect(verbalize('Renew')).toBe('Renew');
        expect(verbalize('AWSCloudWatch')).toBe('AWS Cloud Watch');
        expect(verbalize('already spaced')).toBe('Already Spaced');
        expect(verbalize('')).toBe('');
      });
    });
  });

  describe('readStringDeep helper', () => {
    it('returns leaf string when path exists', async () => {
      const { readStringDeep } = await import('./strategies/helpers');
      const obj = { a: { b: { c: 'hello' } } };
      expect(readStringDeep(obj, ['a', 'b', 'c'])).toBe('hello');
    });

    it('returns null when intermediate is not an object', async () => {
      const { readStringDeep } = await import('./strategies/helpers');
      const obj = { a: 'string-not-object' };
      expect(readStringDeep(obj, ['a', 'b'])).toBe(null);
    });

    it('returns null when leaf is not a string', async () => {
      const { readStringDeep } = await import('./strategies/helpers');
      const obj = { a: { b: 42 } };
      expect(readStringDeep(obj, ['a', 'b'])).toBe(null);
    });

    it('handles null-prototype intermediate objects (#365 regression guard)', async () => {
      const { readStringDeep } = await import('./strategies/helpers');
      const inner: Record<string, unknown> = Object.create(null);
      inner['c'] = 'leaf';
      const outer: Record<string, unknown> = Object.create(null);
      outer['b'] = inner;
      const root: Record<string, unknown> = Object.create(null);
      root['a'] = outer;
      expect(readStringDeep(root, ['a', 'b', 'c'])).toBe('leaf');
    });

    it('returns null for empty path', async () => {
      const { readStringDeep } = await import('./strategies/helpers');
      expect(readStringDeep({ a: 'x' }, [])).toBe(null);
    });
  });

  describe('acceptance: motivating Microsoft Commerce blob', () => {
    // This is the blob the user pasted that motivated Track 1 of the
    // title-suggester redesign. The acceptance criterion is that the
    // menu surfaces both (a) the `microsoftCommerceBillingEvent`
    // composite title and (b) the `identifierField` "Invoice ..."
    // candidate, in addition to lower-confidence fallbacks.
    const MS_COMMERCE_BLOB = `{
      "x-opt-enqueued-time":"2026-02-06T12:59:52.0940000Z",
      "eventType":"chargeInvoiced",
      "eventId":"6fa0d9e7-f9d8-1729-2393-1d154e6def4f",
      "eventTimestamp":"2026-02-06T12:59:52.0875029Z",
      "version":2,
      "charge":{
        "product":"Microsoft 365 Business Basic",
        "sku":"Microsoft 365 Business Basic",
        "action":"Renew"
      },
      "invoiceId":"G138888993",
      "invoiceCreationTime":"2026-02-06T12:59:51.9253774Z"
    }`;

    it('surfaces the microsoftCommerceBillingEvent composite title', () => {
      const result = service.suggest(inputFor(MS_COMMERCE_BLOB));
      const entry = result.find((c) => c.source === 'microsoftCommerceBillingEvent');
      expect(entry?.value).toBe('Charge Invoiced -- Microsoft 365 Business Basic');
    });

    it('surfaces the Invoice identifier candidate', () => {
      const result = service.suggest(inputFor(MS_COMMERCE_BLOB));
      const entry = result.find((c) => c.source === 'identifierField');
      expect(entry?.value).toBe('Invoice G138888993');
    });

    it('puts the composite title at the top (above identifier and selfUrl)', () => {
      const result = service.suggest(inputFor(MS_COMMERCE_BLOB));
      const compositeIdx = result.findIndex((c) => c.source === 'microsoftCommerceBillingEvent');
      const identifierIdx = result.findIndex((c) => c.source === 'identifierField');
      expect(compositeIdx).toBe(0);
      expect(identifierIdx).toBeGreaterThan(compositeIdx);
    });

    it('suppresses eventEnvelope (microsoftCommerceBillingEvent wins)', () => {
      const result = service.suggest(inputFor(MS_COMMERCE_BLOB));
      expect(result.find((c) => c.source === 'eventEnvelope')).toBeUndefined();
    });
  });
});
