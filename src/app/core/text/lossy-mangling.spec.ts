import { decodeLossyMangling, detectLossyMangling, type LossyManglingKind } from './lossy-mangling';

describe('detectLossyMangling', () => {
  describe('httpFraming positives', () => {
    it('classifies the user-supplied request payload as httpFraming', () => {
      const requestDetails =
        'GET https://billinggroups.cp.microsoft.com/ad353f49/billinggroups/YAQ7-GDT5-BG7-PGB' +
        '?includeJarvisAccountId=true??api-version: 2019-05-31' +
        '??x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
        '??MS-CV: 6O12PmSAc0mVnJrl.1??Authorization: Authorization value hash = 784522372????<none>';
      expect(detectLossyMangling(requestDetails).kind).toBe('httpFraming');
    });

    it('classifies the user-supplied response payload as httpFraming', () => {
      const responseDetails =
        '200 OK??Pragma: no-cache' +
        '??Strict-Transport-Security: max-age=63072000; includeSubDomains' +
        '??x-ms-request-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
        '??Cache-Control: no-cache??Date: Wed, 20 May 2026 00:17:38 GMT' +
        '??Server: Microsoft-IIS/10.0??Content-Length: 11058' +
        '??Content-Type: application/json; charset=utf-8??Expires: -1' +
        '????{"organizationId":"e674a4a6-f6f9-4a8d-bb40-3da808769d17_2019-05-31"}';
      expect(detectLossyMangling(responseDetails).kind).toBe('httpFraming');
    });

    it('classifies a minimal three-header response as httpFraming', () => {
      const value = '200 OK??A: x??B: y??C: z????body';
      expect(detectLossyMangling(value).kind).toBe('httpFraming');
    });
  });

  describe('httpFraming negatives', () => {
    it('returns none when the string contains no "??" at all', () => {
      expect(detectLossyMangling('plain text').kind).toBe('none');
    });

    it('returns none for an empty string', () => {
      expect(detectLossyMangling('').kind).toBe('none');
    });

    it('returns none for prose containing "??" but no Header: shapes', () => {
      expect(detectLossyMangling('Wait what?? Is that real?? Surely not??').kind).toBe('none');
    });

    it('returns none for a URL with a single "??Q=1" fragment', () => {
      expect(detectLossyMangling('https://example.com/?a=1??Q=1&b=2').kind).toBe('none');
    });

    it('returns none for TypeScript-style nullish coalescing chains', () => {
      expect(detectLossyMangling('const v = a ?? b ?? c ?? d;').kind).toBe('none');
    });

    it('returns none for a one-header response (below threshold)', () => {
      expect(detectLossyMangling('200 OK??Content-Type: application/json????body').kind).toBe(
        'none',
      );
    });

    it('returns none for a two-header response (below threshold)', () => {
      expect(
        detectLossyMangling('200 OK??Content-Type: application/json??Server: x????body').kind,
      ).toBe('none');
    });

    it('returns none when "?? " has a space before the would-be header name', () => {
      // Space between `??` and the letter means the regex (`??[A-Za-z]`)
      // doesn't latch; protects against ambiguous prose patterns.
      const value = 'A ?? Foo: 1 ?? Bar: 2 ?? Baz: 3';
      expect(detectLossyMangling(value).kind).toBe('none');
    });
  });
});

describe('decodeLossyMangling', () => {
  describe('kind="none"', () => {
    it('returns the input unchanged', () => {
      const value = 'plain text with ?? but no headers';
      expect(decodeLossyMangling(value, 'none')).toBe(value);
    });

    it('returns input unchanged when no "??" remain (idempotent shape)', () => {
      const value = '200 OK\nContent-Type: application/json\n\nbody';
      expect(decodeLossyMangling(value, 'none')).toBe(value);
    });
  });

  describe('kind="httpFraming"', () => {
    it('decodes a standard response with body separator', () => {
      const value = '200 OK??A: x??B: y??C: z????body content';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\nA: x\nB: y\nC: z\n\nbody content',
      );
    });

    it('preserves "??" inside the body verbatim', () => {
      const value = '200 OK??Foo: a??Bar: b??Baz: c????GET /x?token=abc??ver=1';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\nFoo: a\nBar: b\nBaz: c\n\nGET /x?token=abc??ver=1',
      );
    });

    it('preserves an empty body verbatim (trailing separator only)', () => {
      const value = '200 OK??A: 1??B: 2??C: 3????';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe('200 OK\nA: 1\nB: 2\nC: 3\n\n');
    });

    it('decodes the user-supplied request payload', () => {
      const value =
        'GET https://example.com/path?includeJarvisAccountId=true' +
        '??api-version: 2019-05-31' +
        '??x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
        '??MS-CV: 6O12PmSAc0mVnJrl.1' +
        '??Authorization: Authorization value hash = 784522372????<none>';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        'GET https://example.com/path?includeJarvisAccountId=true\n' +
          'api-version: 2019-05-31\n' +
          'x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b\n' +
          'MS-CV: 6O12PmSAc0mVnJrl.1\n' +
          'Authorization: Authorization value hash = 784522372\n' +
          '\n' +
          '<none>',
      );
    });

    it('falls back to header-run walk when no body separator is present', () => {
      const value = '200 OK??A: x??B: y??C: z';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe('200 OK\nA: x\nB: y\nC: z');
    });

    it('stops the header walk at the first non-header segment in the fallback path', () => {
      // Construct a value with no `????` body separator but with a
      // non-header segment after a run of headers. The non-header tail
      // is re-joined with `??` so internal `??` survives.
      const value = '200 OK??A: x??B: y??C: z??not a header??still tail';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\nA: x\nB: y\nC: z\nnot a header??still tail',
      );
    });

    it('handles odd-count "???" runs (extra leading ? becomes part of segment 0)', () => {
      // `???A: x??B: y??C: z????body` -> first `??` at position 0,
      // so segment 0 is empty, segment 1 begins with `?A: x`. The
      // header regex requires segment to start with [A-Za-z], so
      // segment 1 doesn't latch as a header in the fallback path.
      // With the body separator present, the prefix is rewritten by
      // plain split/join, preserving the leading `?` in segment 1.
      const value = '???A: x??B: y??C: z????body';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe('\n?A: x\nB: y\nC: z\n\nbody');
    });

    it('handles "?????" runs (five ?s) by reading the leading "????" as body separator', () => {
      // `?????Header: 1` -> indexOf('????') finds the 4-? run at
      // position 0; the header portion is empty, the body starts at
      // `?Header: 1`. This is fine: the decoder doesn't have to make
      // every weird shape look great; it has to preserve content.
      const value = '?????Header: 1??Other: 2??Third: 3';
      const decoded = decodeLossyMangling(value, 'httpFraming');
      // Body contains all the original content past the 4-? prefix
      // (the body section is rendered verbatim, including the
      // remaining `??` separators between would-be headers).
      expect(decoded.endsWith('?Header: 1??Other: 2??Third: 3')).toBe(true);
    });
  });

  describe('round trip with detect', () => {
    it('returns the input unchanged when detect says "none"', () => {
      const value = 'arbitrary user content with no mangling';
      const kind: LossyManglingKind = detectLossyMangling(value).kind;
      expect(kind).toBe('none');
      expect(decodeLossyMangling(value, kind)).toBe(value);
    });

    it('produces multi-line output when detect says "httpFraming"', () => {
      const value = '200 OK??A: x??B: y??C: z????body';
      const kind = detectLossyMangling(value).kind;
      expect(kind).toBe('httpFraming');
      const decoded = decodeLossyMangling(value, kind);
      expect(decoded.split('\n').length).toBeGreaterThan(1);
    });
  });
});
