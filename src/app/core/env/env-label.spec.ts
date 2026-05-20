import { NONPROD_SWA_STEM, getEnvLabel, getPreviewPrNumber, type EnvLabel } from './env-label';

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

    // preview: stem + `-<slug>` (SWA preview-env shape).
    //
    // Keep the legacy `-pr-<n>` form as classifier-only coverage:
    // Azure historically may have emitted that shape (and could
    // again if deployment_environment naming changes). The
    // `getPreviewPrNumber` block below verifies that the same row
    // returns `null` -- the indicator falls back to plain
    // `[preview]` for slugs that don't match the strict numeric
    // contract.
    {
      hostname: 'calm-flower-01969880f-pr-123.eastus2.7.azurestaticapps.net',
      expected: 'preview',
    },
    {
      hostname: 'calm-flower-01969880f-pr-1.westus2.azurestaticapps.net',
      expected: 'preview',
    },
    // Actual Azure URL shape today: `<stem>-<pr-number>.<region>...`.
    // cd-preview.yml's `PREVIEW_ENV: pr-${{ pull_request.number }}`
    // is passed to Azure SWA as `deployment_environment`; Azure
    // strips the `pr-` prefix.
    {
      hostname: 'calm-flower-01969880f-123.eastus2.7.azurestaticapps.net',
      expected: 'preview',
    },
    // Non-numeric slug (e.g., a manually-named SWA preview slot)
    // still classifies as preview but yields null PR number below.
    {
      hostname: 'calm-flower-01969880f-staging.eastus2.7.azurestaticapps.net',
      expected: 'preview',
    },
    // Multi-segment slug (`1-2`) -- pins the contract that the
    // regex captures up to the first `.`, not greedily past `-`.
    {
      hostname: 'calm-flower-01969880f-1-2.eastus2.7.azurestaticapps.net',
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

describe('getPreviewPrNumber', () => {
  const prCases: ReadonlyArray<{ hostname: string; expected: number | null }> = [
    // Canonical Azure preview shape: stem + `-<number>.<region>.azurestaticapps.net`.
    { hostname: 'calm-flower-01969880f-1.eastus2.7.azurestaticapps.net', expected: 1 },
    { hostname: 'calm-flower-01969880f-7.eastus2.7.azurestaticapps.net', expected: 7 },
    { hostname: 'calm-flower-01969880f-123.eastus2.7.azurestaticapps.net', expected: 123 },
    { hostname: 'calm-flower-01969880f-332.eastus2.7.azurestaticapps.net', expected: 332 },
    { hostname: 'calm-flower-01969880f-9999.westus2.azurestaticapps.net', expected: 9999 },

    // Legacy `-pr-<n>` shape -> null (the indicator falls back to
    // `[preview]`). The classifier above still returns 'preview' for
    // these, but no per-PR rendering happens.
    {
      hostname: 'calm-flower-01969880f-pr-123.eastus2.7.azurestaticapps.net',
      expected: null,
    },
    {
      hostname: 'calm-flower-01969880f-pr-1.westus2.azurestaticapps.net',
      expected: null,
    },

    // Non-numeric slug -> null. Manually-named SWA preview slots
    // (e.g., `staging`, `feature-x`) keep the plain `[preview]`
    // indicator.
    {
      hostname: 'calm-flower-01969880f-staging.eastus2.7.azurestaticapps.net',
      expected: null,
    },

    // Multi-segment slug (`1-2`) -> null. Pins the no-greedy-overflow
    // contract: the regex requires `.` immediately after the digits.
    {
      hostname: 'calm-flower-01969880f-1-2.eastus2.7.azurestaticapps.net',
      expected: null,
    },

    // Non-preview hosts -> null.
    { hostname: 'jotjson.com', expected: null },
    { hostname: 'www.jotjson.com', expected: null },
    { hostname: 'localhost', expected: null },
    { hostname: 'calm-flower-01969880f.eastus2.7.azurestaticapps.net', expected: null },
    { hostname: 'example.com', expected: null },
    { hostname: '', expected: null },

    // Cross-domain attack shapes -- a host that contains the stem
    // plus a digit slug but lives under a different apex must NOT
    // return a PR number. The suffix gate is the line of defense;
    // without it, the regex would match the stem+digit prefix and
    // silently violate the documented contract.
    {
      hostname: 'calm-flower-01969880f-332.evil.example.com',
      expected: null,
    },
    // Suffix-suffix attack: the SWA suffix appears in the middle,
    // not at the end. `endsWith` rejects this regardless of stem.
    {
      hostname: 'calm-flower-01969880f-332.azurestaticapps.net.evil.example.com',
      expected: null,
    },
  ];

  for (const { hostname, expected } of prCases) {
    it(`extracts ${expected ?? 'null'} from "${hostname}"`, () => {
      expect(getPreviewPrNumber(hostname)).toBe(expected);
    });
  }
});
