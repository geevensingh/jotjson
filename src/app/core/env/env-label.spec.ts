import { NONPROD_SWA_STEM, getEnvLabel, type EnvLabel } from './env-label';

describe('getEnvLabel', () => {
  // Stem-drift guard. If this fails, update infra/README.md's nonprod
  // SWA hostname row to match, OR confirm the SWA was recreated and
  // the new stem is captured in both places.
  it('keeps NONPROD_SWA_STEM in sync with infra/README.md:221', () => {
    expect(NONPROD_SWA_STEM).toBe('calm-flower-01969880f');
  });

  const cases: ReadonlyArray<{ hostname: string; expected: EnvLabel }> = [
    // prod (exact)
    { hostname: 'jotjson.com', expected: 'prod' },
    { hostname: 'www.jotjson.com', expected: 'prod' },

    // dev (localhost variants -- forms that window.location.hostname
    // actually returns per the WHATWG URL parser)
    { hostname: 'localhost', expected: 'dev' },
    { hostname: '127.0.0.1', expected: 'dev' },
    { hostname: '[::1]', expected: 'dev' },

    // nonprod: stem + `.` (root SWA hostname, region segment varies)
    {
      hostname: 'calm-flower-01969880f.7.azurestaticapps.net',
      expected: 'nonprod',
    },
    {
      hostname: 'calm-flower-01969880f.8.azurestaticapps.net',
      expected: 'nonprod',
    },
    {
      hostname: 'calm-flower-01969880f.eastus2.7.azurestaticapps.net',
      expected: 'nonprod',
    },

    // preview: stem + `-<slug>` (SWA preview-env shape)
    {
      hostname: 'calm-flower-01969880f-pr-123.eastus2.7.azurestaticapps.net',
      expected: 'preview',
    },
    {
      hostname: 'calm-flower-01969880f-pr-1.westus2.azurestaticapps.net',
      expected: 'preview',
    },

    // unknown: empty (file://), unrelated SWA, foreign apex
    { hostname: '', expected: 'unknown' },
    { hostname: 'some-other-app.azurestaticapps.net', expected: 'unknown' },
    { hostname: 'evil-jotjson.com', expected: 'unknown' },
    { hostname: 'example.com', expected: 'unknown' },

    // unknown: exact-suffix boundary cases. Pins the contract that
    // dropping the `hostname.length > swaSuffix.length` guard in the
    // inline mirror at `src/index.html` is safe: an empty stem fails
    // both `startsWith` checks and falls through to 'unknown'.
    { hostname: '.azurestaticapps.net', expected: 'unknown' },
    { hostname: 'azurestaticapps.net', expected: 'unknown' },
  ];

  for (const { hostname, expected } of cases) {
    it(`classifies "${hostname}" as ${expected}`, () => {
      expect(getEnvLabel(hostname)).toBe(expected);
    });
  }

  it('rejects a hostname that merely contains the SWA suffix but does not end with it', () => {
    expect(getEnvLabel('calm-flower-01969880f.7.azurestaticapps.net.evil.example')).toBe('unknown');
  });

  it('rejects a hostname that contains the stem but does not start with it', () => {
    expect(getEnvLabel('attacker-calm-flower-01969880f.7.azurestaticapps.net')).toBe('unknown');
  });
});
