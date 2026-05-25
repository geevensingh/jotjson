import { decodeLossyMangling, detectLossyMangling, type LossyManglingKind } from './lossy-mangling';

describe('detectLossyMangling', () => {
  describe('returns "httpFraming" when count("??") > count(line breaks)', () => {
    it('classifies the user-supplied request payload', () => {
      const requestDetails =
        'GET https://billinggroups.cp.microsoft.com/ad353f49/billinggroups/YAQ7-GDT5-BG7-PGB' +
        '?includeJarvisAccountId=true??api-version: 2019-05-31' +
        '??x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
        '??MS-CV: 6O12PmSAc0mVnJrl.1??Authorization: Authorization value hash = 784522372????<none>';
      expect(detectLossyMangling(requestDetails).kind).toBe('httpFraming');
    });

    it('classifies the user-supplied response payload', () => {
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

    it('classifies a single "??" in a line-break-free string', () => {
      // The detection rule is intentionally permissive: a single `??`
      // with no preserved line breaks is enough to surface the toggle.
      // The cost of this false positive is one extra (no-op) flip.
      expect(detectLossyMangling('a??b').kind).toBe('httpFraming');
    });

    it('classifies prose with multiple "??" and no line breaks (acknowledged FP)', () => {
      // "Wait what?? Is that real?? Surely not??" trips the rule even
      // though `??` is literal punctuation here, not a transcoded line
      // break. Documented as accepted: see the file-level JSDoc.
      expect(detectLossyMangling('Wait what?? Is that real?? Surely not??').kind).toBe(
        'httpFraming',
      );
    });

    it('classifies TypeScript-style nullish coalescing chains (acknowledged FP)', () => {
      // `const v = a ?? b ?? c ?? d;` has 3 `??` and 0 line breaks, so
      // it trips the rule. The toggle is the cost: the user flips it
      // off again and continues. Apply is opt-in behind a separate
      // click, so this FP cannot silently corrupt data.
      expect(detectLossyMangling('const v = a ?? b ?? c ?? d;').kind).toBe('httpFraming');
    });

    it('classifies a URL with a single "??Q=1" fragment (acknowledged FP)', () => {
      expect(detectLossyMangling('https://example.com/?a=1??Q=1&b=2').kind).toBe('httpFraming');
    });

    it('classifies a two-header response (no line breaks)', () => {
      expect(
        detectLossyMangling('200 OK??Content-Type: application/json??Server: x????body').kind,
      ).toBe('httpFraming');
    });

    it('still classifies when there are some line breaks but more "??" markers', () => {
      // Six `??`, two `\n` -> still fires.
      const value =
        'preamble\nGET /x??api-version: 2019-05-31??MS-CV: abc??Authorization: hash=1\nfooter';
      expect(detectLossyMangling(value).kind).toBe('httpFraming');
    });

    it('counts non-overlapping "??" inside a "????" run as 2 (not 1 or 3)', () => {
      // `??????` -> indexOf walk gives 3 non-overlapping `??`s.
      // 3 > 0 line breaks -> fires.
      expect(detectLossyMangling('header??????body').kind).toBe('httpFraming');
    });
  });

  describe('returns "none" when count("??") <= count(line breaks)', () => {
    it('returns none when the string contains no "??" at all', () => {
      expect(detectLossyMangling('plain text').kind).toBe('none');
    });

    it('returns none for an empty string', () => {
      expect(detectLossyMangling('').kind).toBe('none');
    });

    it('returns none when "??" count is exactly equal to line-break count', () => {
      // 2 `??`s, 2 `\n`s. 2 > 2 is false; rule does NOT fire.
      expect(detectLossyMangling('a??b\nc??d\ne').kind).toBe('none');
    });

    it('returns none for already-multi-line content with more line breaks than "??"', () => {
      // 1 `??`, 3 `\n`s. Already-multi-line; the lone `??` is most
      // likely literal punctuation, not a transcoded line break.
      expect(detectLossyMangling('line1\nline2 ?? still line2\nline3\nline4').kind).toBe('none');
    });

    it('counts CRLF as one line break (so CRLF-rich content does not over-fire)', () => {
      // 1 `??`, 1 CRLF (counts as one). 1 > 1 is false; no fire.
      expect(detectLossyMangling('foo\r\nbar ?? baz').kind).toBe('none');
    });

    it('counts lone CR as one line break', () => {
      // 1 `??`, 1 `\r`. 1 > 1 is false; no fire.
      expect(detectLossyMangling('foo\rbar ?? baz').kind).toBe('none');
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

  describe('kind="httpFraming" with `????` body separator (prefix-only)', () => {
    it('decodes a standard response with body separator', () => {
      const value = '200 OK??A: x??B: y??C: z????body content';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\r\nA: x\r\nB: y\r\nC: z\r\n\r\nbody content',
      );
    });

    it('preserves "??" inside the body verbatim', () => {
      const value = '200 OK??Foo: a??Bar: b??Baz: c????GET /x?token=abc??ver=1';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\r\nFoo: a\r\nBar: b\r\nBaz: c\r\n\r\nGET /x?token=abc??ver=1',
      );
    });

    it('preserves an empty body verbatim (trailing separator only)', () => {
      const value = '200 OK??A: 1??B: 2??C: 3????';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\r\nA: 1\r\nB: 2\r\nC: 3\r\n\r\n',
      );
    });

    it('decodes the user-supplied request payload', () => {
      const value =
        'GET https://example.com/path?includeJarvisAccountId=true' +
        '??api-version: 2019-05-31' +
        '??x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
        '??MS-CV: 6O12PmSAc0mVnJrl.1' +
        '??Authorization: Authorization value hash = 784522372????<none>';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        'GET https://example.com/path?includeJarvisAccountId=true\r\n' +
          'api-version: 2019-05-31\r\n' +
          'x-ms-correlation-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b\r\n' +
          'MS-CV: 6O12PmSAc0mVnJrl.1\r\n' +
          'Authorization: Authorization value hash = 784522372\r\n' +
          '\r\n' +
          '<none>',
      );
    });

    it('handles odd-count "???" runs (extra leading "?" stays attached to the next segment)', () => {
      const value = '???A: x??B: y??C: z????body';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '\r\n?A: x\r\nB: y\r\nC: z\r\n\r\nbody',
      );
    });

    it('handles "?????" runs by treating the leading "????" as the body separator', () => {
      // indexOf('????') latches at position 0; header portion is empty,
      // body starts at `?Header: 1??Other: 2??Third: 3`.
      const value = '?????Header: 1??Other: 2??Third: 3';
      const decoded = decodeLossyMangling(value, 'httpFraming');
      expect(decoded.endsWith('?Header: 1??Other: 2??Third: 3')).toBe(true);
    });
  });

  describe('kind="httpFraming" without `????` body separator (fallback global replace)', () => {
    it('replaces every "??" with CRLF', () => {
      const value = '200 OK??A: x??B: y??C: z';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe('200 OK\r\nA: x\r\nB: y\r\nC: z');
    });

    it('replaces "??" everywhere including non-header-shaped segments', () => {
      // Under the v1.2 prefix decoder this case stopped at the first
      // non-header segment. The v1.3 fallback is the simpler global
      // replace because the broadened detection rule no longer
      // identifies a header section. The user previews the result via
      // the toggle and chooses whether to commit it via Apply.
      const value = '200 OK??A: x??B: y??C: z??not a header??still tail';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        '200 OK\r\nA: x\r\nB: y\r\nC: z\r\nnot a header\r\nstill tail',
      );
    });

    it('replaces "??" in plain prose', () => {
      const value = 'Wait what?? Is that real?? Surely not??';
      expect(decodeLossyMangling(value, 'httpFraming')).toBe(
        'Wait what\r\n Is that real\r\n Surely not\r\n',
      );
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
      expect(decoded.split('\r\n').length).toBeGreaterThan(1);
    });
  });
});
