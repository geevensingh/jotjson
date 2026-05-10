import { extractAadCode, redactPii, truncate } from './redact-pii';

describe('redactPii', () => {
  it('replaces a plain email', () => {
    expect(redactPii('login failed for alice@example.com today')).toBe(
      'login failed for <email> today',
    );
  });

  it('replaces multiple emails', () => {
    expect(redactPii('a@b.co and c.d+tag@e-f.io')).toBe('<email> and <email>');
  });

  it('replaces UPN-style identifiers in MSAL prose', () => {
    const out = redactPii(
      "AADSTS50058: Session info is not sufficient for user 'alice@contoso.onmicrosoft.com'",
    );
    expect(out).not.toContain('alice@contoso.onmicrosoft.com');
    expect(out).toContain('<email>');
  });

  it('preserves GUIDs', () => {
    const guid = 'aeeb2cf4-5305-4a6f-85e6-6b97d75bd259';
    expect(redactPii(`oid=${guid}`)).toContain(guid);
  });

  it('handles empty / undefined input safely', () => {
    expect(redactPii('')).toBe('');
  });

  it('is approximately idempotent', () => {
    const once = redactPii('hello bob@x.io');
    expect(redactPii(once)).toBe(once);
  });
});

describe('extractAadCode', () => {
  it('extracts AADSTS code', () => {
    expect(extractAadCode('AADSTS50058: blah blah')).toBe('AADSTS50058');
  });

  it('returns undefined when absent', () => {
    expect(extractAadCode('generic error')).toBeUndefined();
  });

  it('returns the first match when multiple present', () => {
    expect(extractAadCode('AADSTS70011 and later AADSTS50058')).toBe('AADSTS70011');
  });
});

describe('truncate', () => {
  it('returns input unchanged when within limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates and appends ellipsis', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd\u2026');
  });

  it('handles empty input', () => {
    expect(truncate('', 5)).toBe('');
  });
});
