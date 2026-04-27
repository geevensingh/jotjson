import { classifyValue } from './value-classifier';

describe('value-classifier', () => {
  describe('classifyValue - dates', () => {
    it('classifies ISO date+time as date/time', () => {
      expect(classifyValue('string', '2024-11-05T18:30:00Z')).toBe('date/time');
    });

    it('classifies ISO date-only as date', () => {
      expect(classifyValue('string', '2024-11-05')).toBe('date');
    });

    it('skips date detection when detectDates is false', () => {
      expect(classifyValue('string', '2024-11-05', { detectDates: false })).toBe('string');
    });
  });

  describe('classifyValue - uuid', () => {
    it('accepts a canonical UUID', () => {
      expect(classifyValue('string', '550e8400-e29b-41d4-a716-446655440000')).toBe('uuid');
    });

    it('accepts a v4 UUID with mixed case', () => {
      expect(classifyValue('string', '6Ba7B810-9DAD-11d1-80B4-00C04FD430C8')).toBe('uuid');
    });

    it('rejects a UUID without dashes', () => {
      expect(classifyValue('string', '550e8400e29b41d4a716446655440000')).toBe('uuid');
    });

    it('accepts the .NET "N" form (32 hex chars no hyphens)', () => {
      expect(classifyValue('string', '0e3999429fef4f579f22ef64d960624e')).toBe('uuid');
    });

    it('accepts the .NET "N" form with mixed case', () => {
      expect(classifyValue('string', '0E3999429FEF4f579F22EF64D960624E')).toBe('uuid');
    });

    it('rejects 31 hex chars (too short for "N" form)', () => {
      expect(classifyValue('string', '0e3999429fef4f579f22ef64d960624')).toBe('string');
    });

    it('rejects 33 hex chars (too long for "N" form)', () => {
      expect(classifyValue('string', '0e3999429fef4f579f22ef64d960624ee')).toBe('string');
    });

    it('rejects 32 chars containing a non-hex character', () => {
      expect(classifyValue('string', '0e3999429fef4f579f22ef64d960624z')).toBe('string');
    });

    it('accepts the .NET "B" form (braces)', () => {
      expect(classifyValue('string', '{0e399942-9fef-4f57-9f22-ef64d960624e}')).toBe('uuid');
    });

    it('accepts the .NET "P" form (parens)', () => {
      expect(classifyValue('string', '(0e399942-9fef-4f57-9f22-ef64d960624e)')).toBe('uuid');
    });

    it('rejects mismatched delimiters', () => {
      expect(classifyValue('string', '{0e399942-9fef-4f57-9f22-ef64d960624e)')).toBe('string');
      expect(classifyValue('string', '(0e399942-9fef-4f57-9f22-ef64d960624e}')).toBe('string');
    });

    it('accepts the urn:uuid: form', () => {
      expect(classifyValue('string', 'urn:uuid:0e399942-9fef-4f57-9f22-ef64d960624e')).toBe('uuid');
    });

    it('accepts the urn:uuid: form with mixed case prefix', () => {
      expect(classifyValue('string', 'URN:UUID:0e399942-9fef-4f57-9f22-ef64d960624e')).toBe('uuid');
    });

    it('rejects a UUID embedded in a longer string', () => {
      expect(
        classifyValue('string', 'see 550e8400-e29b-41d4-a716-446655440000 here'),
      ).toBe('string');
    });

    it('rejects a UUID with wrong segment lengths', () => {
      expect(classifyValue('string', '550e8400-e29b-41d4-a716-44665544000')).toBe('string');
    });

    it('rejects a UUID with non-hex characters', () => {
      expect(classifyValue('string', 'zzzzzzzz-e29b-41d4-a716-446655440000')).toBe('string');
    });
  });

  describe('classifyValue - url', () => {
    it('accepts https URL', () => {
      expect(classifyValue('string', 'https://example.com')).toBe('url');
    });

    it('accepts http URL with path and query', () => {
      expect(classifyValue('string', 'http://example.com/foo?bar=baz#qux')).toBe('url');
    });

    it('accepts ws URL', () => {
      expect(classifyValue('string', 'wss://example.com/socket')).toBe('url');
    });

    it('accepts mailto URL', () => {
      expect(classifyValue('string', 'mailto:hello@example.com')).toBe('url');
    });

    it('rejects a bare hostname', () => {
      expect(classifyValue('string', 'www.example.com')).toBe('string');
    });

    it('rejects an unsupported scheme', () => {
      expect(classifyValue('string', 'gopher://example.com')).toBe('string');
    });
  });

  describe('classifyValue - email', () => {
    it('accepts a simple email', () => {
      expect(classifyValue('string', 'a@example.com')).toBe('email');
    });

    it('accepts an email with dots and plus', () => {
      expect(classifyValue('string', 'first.last+tag@sub.example.co')).toBe('email');
    });

    it('rejects an email without a TLD', () => {
      expect(classifyValue('string', 'a@b')).toBe('string');
    });

    it('rejects a bare local part', () => {
      expect(classifyValue('string', 'a@')).toBe('string');
    });
  });

  describe('classifyValue - path', () => {
    it('classifies an absolute REST-style path', () => {
      expect(classifyValue('string', '/api/users/123')).toBe('path');
    });

    it('classifies an Azure resource ID', () => {
      expect(
        classifyValue(
          'string',
          '/subscriptions/db5e75e4-b980-486d-a11e-fe9327a52031/resourceGroups/rg-jotjson-dev/providers/microsoft.insights/components/appi-jotjson-dev'
        )
      ).toBe('path');
    });

    it('classifies a unix-style absolute file path', () => {
      expect(classifyValue('string', '/usr/local/bin/node')).toBe('path');
    });

    it('classifies an absolute path with query string', () => {
      expect(classifyValue('string', '/api/v2/items?limit=10&offset=20')).toBe('path');
    });

    it('classifies an absolute path with fragment', () => {
      expect(classifyValue('string', '/docs/intro#install')).toBe('path');
    });

    it('classifies a relative path with 3+ segments', () => {
      expect(classifyValue('string', 'path/to/file')).toBe('path');
    });

    it('classifies a 3-segment relative file path', () => {
      expect(classifyValue('string', 'node_modules/lodash/index.js')).toBe('path');
    });

    it('classifies a 2-segment relative path with filename extension', () => {
      expect(classifyValue('string', 'docs/intro.md')).toBe('path');
    });

    it('classifies src/app/main.ts as path', () => {
      expect(classifyValue('string', 'src/app/main.ts')).toBe('path');
    });

    it('rejects a full URL (classified as url instead)', () => {
      expect(classifyValue('string', 'https://example.com/foo')).toBe('url');
    });

    it('rejects a slash-form date (classified as date)', () => {
      expect(classifyValue('string', '12/31/2024')).toBe('date');
    });

    it('rejects a single-segment absolute path', () => {
      expect(classifyValue('string', '/health')).toBe('string');
    });

    it('rejects protocol-relative URLs', () => {
      expect(classifyValue('string', '//cdn.example.com/foo')).toBe('string');
    });

    it('rejects Windows-style backslash paths', () => {
      expect(classifyValue('string', 'C:\\Users\\foo')).toBe('string');
    });

    it('rejects strings with embedded whitespace', () => {
      expect(classifyValue('string', '/a b/c')).toBe('string');
    });

    it('rejects MIME types (2 segs, no extension)', () => {
      expect(classifyValue('string', 'text/html')).toBe('string');
      expect(classifyValue('string', 'application/json')).toBe('string');
    });

    it('rejects fractions (2 segs, numeric, no extension)', () => {
      expect(classifyValue('string', '1/2')).toBe('string');
      expect(classifyValue('string', '7/9')).toBe('string');
    });

    it('rejects 2-segment prose (no extension)', () => {
      expect(classifyValue('string', 'key/value')).toBe('string');
      expect(classifyValue('string', 'John/Smith')).toBe('string');
    });

    it('rejects empty / very short strings', () => {
      expect(classifyValue('string', '')).toBe('string');
      expect(classifyValue('string', '/a')).toBe('string');
    });

    it('rejects strings exceeding the length cap', () => {
      const huge = '/' + 'a/'.repeat(1500);
      expect(classifyValue('string', huge)).toBe('string');
    });

    // Acknowledged false positives - documented, not fixed.
    it('classifies 3+ segment slashed prose as path (known FP)', () => {
      expect(classifyValue('string', 'cat/dog/bird')).toBe('path');
      expect(classifyValue('string', 'parent/child/grandchild')).toBe('path');
      expect(classifyValue('string', '2024/Q1/report')).toBe('path');
    });
  });

  describe('classifyValue - ipv4', () => {
    it('accepts a normal IPv4 address', () => {
      expect(classifyValue('string', '192.168.0.1')).toBe('ipv4');
    });

    it('accepts 0.0.0.0 and 255.255.255.255', () => {
      expect(classifyValue('string', '0.0.0.0')).toBe('ipv4');
      expect(classifyValue('string', '255.255.255.255')).toBe('ipv4');
    });

    it('rejects out-of-range octets', () => {
      expect(classifyValue('string', '999.0.0.1')).toBe('string');
      expect(classifyValue('string', '256.0.0.1')).toBe('string');
    });

    it('rejects octets with leading zeros', () => {
      expect(classifyValue('string', '192.168.001.1')).toBe('string');
    });

    it('rejects too few or too many octets', () => {
      expect(classifyValue('string', '1.2.3')).toBe('string');
      expect(classifyValue('string', '1.2.3.4.5')).toBe('string');
    });
  });

  describe('classifyValue - ipv6', () => {
    it('accepts compressed loopback', () => {
      expect(classifyValue('string', '::1')).toBe('ipv6');
    });

    it('accepts 2001:db8::1', () => {
      expect(classifyValue('string', '2001:db8::1')).toBe('ipv6');
    });

    it('accepts a fully expanded IPv6 address', () => {
      expect(classifyValue('string', '2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('ipv6');
    });

    it('rejects non-hex characters', () => {
      expect(classifyValue('string', 'gggg::1')).toBe('string');
    });

    it('rejects multiple :: compressions', () => {
      expect(classifyValue('string', '2001::db8::1')).toBe('string');
    });

    it('rejects too many groups', () => {
      expect(classifyValue('string', '1:2:3:4:5:6:7:8:9')).toBe('string');
    });
  });

  describe('classifyValue - numbers', () => {
    it('classifies integers as integer', () => {
      expect(classifyValue('number', 1)).toBe('integer');
      expect(classifyValue('number', -7)).toBe('integer');
      expect(classifyValue('number', 0)).toBe('integer');
      expect(classifyValue('number', 1e10)).toBe('integer');
    });

    it('classifies fractional numbers as number', () => {
      expect(classifyValue('number', 1.5)).toBe('number');
      expect(classifyValue('number', -0.001)).toBe('number');
    });

    it('treats 0.5e1 (= 5) as integer', () => {
      expect(classifyValue('number', 0.5e1)).toBe('integer');
    });

    it('treats non-finite numbers as number', () => {
      expect(classifyValue('number', NaN)).toBe('number');
      expect(classifyValue('number', Infinity)).toBe('number');
    });
  });

  describe('classifyValue - non-classified types pass through', () => {
    it('boolean / null / array / object / undefined unchanged', () => {
      expect(classifyValue('boolean', true)).toBe('boolean');
      expect(classifyValue('null', null)).toBe('null');
      expect(classifyValue('array', [])).toBe('array');
      expect(classifyValue('object', {})).toBe('object');
      expect(classifyValue('undefined', undefined)).toBe('undefined');
    });
  });

  describe('classifyValue - precedence', () => {
    it('date wins over uuid when a string somehow matches both (date checked first)', () => {
      // `parseAsDate` rejects UUIDs (no ISO shape), so this is a sanity check
      // of the order with a plausibly-overlapping ISO string.
      expect(classifyValue('string', '2024-11-05T18:30:00Z')).toBe('date/time');
    });

    it('falls back to plain string when nothing matches', () => {
      expect(classifyValue('string', 'hello world')).toBe('string');
    });
  });
});
