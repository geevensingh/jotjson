import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  checkDependabotConfig,
  checkExplicitAppliesTo,
  checkFamilyExclusions,
  checkGroupPolicy,
  checkIgnorePolicy,
  checkNoDuplicatePatterns,
  checkNoUpdateTypesOnSecurityGroups,
  checkPeerLockedFamilySync,
  DEPENDABOT_CONFIG,
  ecosystemKey,
  GROUP_POLICY,
  isPatternExcluded,
  parseConfig,
  wildcardMatch,
} from './check-dependabot-config.mjs';
import { PEER_LOCKED_FAMILIES } from './check-lockfile.mjs';

/** Minimal `updates` entry; tests override only what they exercise. */
function update(overrides = {}) {
  return { 'package-ecosystem': 'npm', directory: '/', ...overrides };
}

function group(overrides = {}) {
  return { 'applies-to': 'version-updates', ...overrides };
}

// ---------------------------------------------------------------------------
// parseConfig
// ---------------------------------------------------------------------------

test('parseConfig reports malformed YAML rather than throwing', () => {
  const { updates, error } = parseConfig('updates: [\n  - foo: "unterminated\n');
  assert.deepEqual(updates, []);
  assert.match(error, /failed to parse/);
});

test('parseConfig rejects a config with no updates array', () => {
  const { error } = parseConfig('version: 2\n');
  assert.match(error, /no top-level `updates` array/);
});

test('parseConfig rejects a non-object document', () => {
  const { error } = parseConfig('just a string\n');
  assert.match(error, /did not parse to an object/);
});

test('parseConfig rejects a top-level sequence document', () => {
  const { error } = parseConfig('- one\n- two\n');
  assert.match(error, /did not parse to an object/);
});

// Structural validation of each `updates[i]`. Without it, `updates: [null]`
// throws in ecosystemKey and `groups: 'nope'` makes Object.entries enumerate
// the string's character indices, reporting a group named '0'. A gate whose
// failure output misleads is worse than one that fails loudly.
for (const [label, yamlText, expected] of [
  [
    'a string entry',
    "version: 2\nupdates: ['oops']\n",
    /`updates\[0\]` is a string, not a mapping/,
  ],
  ['a null entry', 'version: 2\nupdates: [null]\n', /`updates\[0\]` is null, not a mapping/],
  ['a number entry', 'version: 2\nupdates: [42]\n', /`updates\[0\]` is a number, not a mapping/],
  [
    'a nested sequence',
    'version: 2\nupdates: [[1, 2]]\n',
    /`updates\[0\]` is a sequence, not a mapping/,
  ],
]) {
  test(`parseConfig rejects ${label} without throwing`, () => {
    const { updates, error } = parseConfig(yamlText);
    assert.deepEqual(updates, []);
    assert.match(error, expected);
  });

  test(`checkDependabotConfig surfaces ${label} as one clear problem`, () => {
    // assert.doesNotThrow is the point of the test: the pre-fix code raised
    // `TypeError: Cannot read properties of null` for the null case.
    let problems;
    assert.doesNotThrow(() => {
      problems = checkDependabotConfig(yamlText);
    });
    assert.equal(
      problems.length,
      1,
      `expected a single structural error, got:\n${problems?.join('\n')}`,
    );
    assert.match(problems[0], expected);
  });
}

test('parseConfig rejects a non-mapping groups value', () => {
  const { error } = parseConfig(
    "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    groups: 'nope'\n",
  );
  assert.match(error, /`updates\[0\]\.groups` is a string, not a mapping/);
});

test('parseConfig rejects a non-sequence ignore value', () => {
  const { error } = parseConfig(
    "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore: 'nope'\n",
  );
  assert.match(error, /`updates\[0\]\.ignore` is a string, not a sequence/);
});

test('parseConfig rejects an entry with no package-ecosystem', () => {
  const { error } = parseConfig('version: 2\nupdates:\n  - directory: /\n');
  assert.match(error, /`updates\[0\]\.package-ecosystem` is missing or not a string/);
});

test('parseConfig reports every structural problem, not just the first', () => {
  const { error } = parseConfig('version: 2\nupdates:\n  - null\n  - 42\n');
  assert.match(error, /`updates\[0\]` is null/);
  assert.match(error, /`updates\[1\]` is a number/);
});

test('parseConfig accepts entries that omit the optional groups and ignore keys', () => {
  const { updates, error } = parseConfig(
    'version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n',
  );
  assert.equal(error, null);
  assert.equal(updates.length, 1);
});

test('ecosystemKey defaults a missing directory to /', () => {
  assert.equal(ecosystemKey({ 'package-ecosystem': 'github-actions' }), 'github-actions:/');
  assert.equal(ecosystemKey(update({ directory: '/api' })), 'npm:/api');
});

// ---------------------------------------------------------------------------
// A: explicit applies-to -- the actual #506 regression
// ---------------------------------------------------------------------------

test('checkExplicitAppliesTo catches the #506 bug: a group with no applies-to', () => {
  // This is the exact shape that shipped: patterns + exclude-patterns, and no
  // applies-to, so security updates silently bypassed the group.
  const problems = checkExplicitAppliesTo([
    update({
      groups: {
        angular: {
          patterns: ['@angular/*', '@angular-devkit/*'],
          'exclude-patterns': ['@angular/material', '@angular/cdk'],
        },
      },
    }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not declare `applies-to`/);
  assert.match(problems[0], /#506/);
});

test('checkExplicitAppliesTo rejects an invalid applies-to value', () => {
  const problems = checkExplicitAppliesTo([
    update({ groups: { angular: { 'applies-to': 'both' } } }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not one of version-updates \/ security-updates/);
});

test('checkExplicitAppliesTo passes when every group is explicit', () => {
  assert.deepEqual(
    checkExplicitAppliesTo([
      update({
        groups: {
          angular: group(),
          'angular-security': group({ 'applies-to': 'security-updates' }),
        },
      }),
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------
// B: no update-types on security groups
// ---------------------------------------------------------------------------

test('checkNoUpdateTypesOnSecurityGroups rejects GitHub documented Example 4', () => {
  // GitHub's own docs show this exact shape. It is wrong: the SemVer gate
  // compares against checker.latest_version, which security-path ignores
  // cannot lower, so every package with a newer major is ejected.
  const problems = checkNoUpdateTypesOnSecurityGroups([
    update({
      groups: {
        'minor-and-patch': {
          'applies-to': 'security-updates',
          patterns: ['@angular*'],
          'update-types': ['patch', 'minor'],
        },
      },
    }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /structurally\n\s+broken on the security path/);
  assert.match(problems[0], /Example 4/);
});

test('checkNoUpdateTypesOnSecurityGroups allows update-types on version groups', () => {
  assert.deepEqual(
    checkNoUpdateTypesOnSecurityGroups([
      update({
        groups: {
          'dev-minor': group({
            'dependency-type': 'development',
            'update-types': ['minor', 'patch'],
          }),
        },
      }),
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------
// C: GROUP_POLICY classification
// ---------------------------------------------------------------------------

const policyFixture = {
  'npm:/': {
    angular: {
      kind: 'peer-locked',
      security: 'mirrored',
      mirror: 'angular-security',
      rationale: 'exact peer pins',
    },
    'angular-security': {
      kind: 'peer-locked',
      security: 'is-mirror',
      mirrorOf: 'angular',
      rationale: 'consolidation only',
    },
  },
};

function angularPair() {
  return update({
    groups: {
      angular: group({ patterns: ['@angular/*'] }),
      'angular-security': group({ 'applies-to': 'security-updates', patterns: ['@angular/*'] }),
    },
  });
}

test('checkGroupPolicy accepts a correctly classified mirrored pair', () => {
  assert.deepEqual(checkGroupPolicy([angularPair()], policyFixture, {}), []);
});

test('checkGroupPolicy rejects an unclassified group', () => {
  const entry = angularPair();
  entry.groups.newthing = group({ patterns: ['newthing'] });
  const problems = checkGroupPolicy([entry], policyFixture, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'newthing' is not classified in GROUP_POLICY/);
});

test('checkGroupPolicy rejects a stale policy entry for a removed group', () => {
  const entry = update({ groups: { angular: group({ patterns: ['@angular/*'] }) } });
  const problems = checkGroupPolicy([entry], policyFixture, {});
  assert.ok(
    problems.some((problem) =>
      /classifies 'angular-security', which no longer exists/.test(problem),
    ),
  );
});

test('checkGroupPolicy rejects a mirrored group whose mirror is missing', () => {
  const entry = update({ groups: { angular: group({ patterns: ['@angular/*'] }) } });
  const policy = { 'npm:/': { angular: policyFixture['npm:/'].angular } };
  const problems = checkGroupPolicy([entry], policy, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'angular-security' does not exist/);
});

test('checkGroupPolicy requires the mirror relation to agree in both directions', () => {
  const policy = {
    'npm:/': {
      angular: { ...policyFixture['npm:/'].angular, mirror: 'somewhere-else' },
      'angular-security': policyFixture['npm:/']['angular-security'],
    },
  };
  const problems = checkGroupPolicy([angularPair()], policy, {});
  assert.ok(problems.some((problem) => /must agree\n\s+in both directions/.test(problem)));
});

test('checkGroupPolicy rejects an inert classification that has a mirror anyway', () => {
  const entry = update({
    groups: {
      vitest: group({ patterns: ['vitest'] }),
      'vitest-security': group({ 'applies-to': 'security-updates', patterns: ['vitest'] }),
    },
  });
  const policy = {
    'npm:/': {
      vitest: { kind: 'peer-locked', security: 'inert', rationale: 'transitive, exact-pinned' },
      'vitest-security': {
        kind: 'peer-locked',
        security: 'is-mirror',
        mirrorOf: 'vitest',
        rationale: 'x',
      },
    },
  };
  const problems = checkGroupPolicy([entry], policy, {});
  assert.ok(
    problems.some((problem) => /classified 'inert' but 'vitest-security' exists/.test(problem)),
  );
});

test('checkGroupPolicy requires a rationale', () => {
  const policy = {
    'npm:/': {
      angular: { kind: 'peer-locked', security: 'mirrored', mirror: 'angular-security' },
      'angular-security': policyFixture['npm:/']['angular-security'],
    },
  };
  const problems = checkGroupPolicy([angularPair()], policy, {});
  assert.ok(problems.some((problem) => /has no rationale/.test(problem)));
});

test('checkGroupPolicy rejects an unknown kind', () => {
  const policy = {
    'npm:/': {
      angular: { ...policyFixture['npm:/'].angular, kind: 'whatever' },
      'angular-security': policyFixture['npm:/']['angular-security'],
    },
  };
  const problems = checkGroupPolicy([angularPair()], policy, {});
  assert.ok(problems.some((problem) => /kind 'whatever'/.test(problem)));
});

test('checkGroupPolicy flags a version/security pair that disagrees on exclude-patterns', () => {
  const entry = update({
    groups: {
      angular: group({ patterns: ['@angular/*'], 'exclude-patterns': ['@angular/material'] }),
      'angular-security': group({ 'applies-to': 'security-updates', patterns: ['@angular/*'] }),
    },
  });
  const problems = checkGroupPolicy([entry], policyFixture, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /disagree on exclude-patterns/);
});

test('checkGroupPolicy requires an ungrouped ecosystem to be registered', () => {
  const problems = checkGroupPolicy([update({ 'package-ecosystem': 'docker' })], {}, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not registered in UNGROUPED_ECOSYSTEMS/);
});

test('checkGroupPolicy accepts a registered ungrouped ecosystem', () => {
  assert.deepEqual(
    checkGroupPolicy(
      [update({ 'package-ecosystem': 'github-actions' })],
      {},
      {
        'github-actions:/': { rationale: 'independent bumps' },
      },
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// D: IGNORE_POLICY -- the versions:/update-types: security asymmetry
// ---------------------------------------------------------------------------

test('checkIgnorePolicy flags a versions: ignore not marked as suppressing security', () => {
  // A `versions:` ignore DOES apply to security updates, so it can mask a
  // live advisory. Adding one silently must be impossible.
  const problems = checkIgnorePolicy(
    [update({ ignore: [{ 'dependency-name': 'lodash', versions: ['>= 5.0.0'] }] })],
    { 'npm:/': { lodash: { suppressesSecurity: false, rationale: 'x' } } },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /carries a `versions:` key/);
  assert.match(problems[0], /can mask a live advisory/);
});

test('checkIgnorePolicy accepts a versions: ignore that declares the suppression', () => {
  assert.deepEqual(
    checkIgnorePolicy(
      [update({ ignore: [{ 'dependency-name': 'lodash', versions: ['>= 5.0.0'] }] })],
      {
        'npm:/': {
          lodash: { suppressesSecurity: true, blockingIssue: '#1', rationale: 'deliberate' },
        },
      },
    ),
    [],
  );
});

test('checkIgnorePolicy flags an update-types-only entry that overstates its risk', () => {
  const problems = checkIgnorePolicy(
    [
      update({
        ignore: [{ 'dependency-name': 'lodash', 'update-types': ['version-update:semver-major'] }],
      }),
    ],
    { 'npm:/': { lodash: { suppressesSecurity: true, rationale: 'x' } } },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does NOT suppress security updates/);
});

test('checkIgnorePolicy rejects an unregistered ignore entry', () => {
  const problems = checkIgnorePolicy(
    [
      update({
        ignore: [{ 'dependency-name': 'lodash', 'update-types': ['version-update:semver-major'] }],
      }),
    ],
    { 'npm:/': {} },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not registered in IGNORE_POLICY/);
});

test('checkIgnorePolicy rejects a stale registry entry', () => {
  const problems = checkIgnorePolicy([update({ ignore: [] })], {
    'npm:/': { lodash: { suppressesSecurity: false, rationale: 'x' } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer ignored in the config/);
});

// ---------------------------------------------------------------------------
// E1: duplicate patterns
// ---------------------------------------------------------------------------

test('checkNoDuplicatePatterns flags one pattern in two same-path groups', () => {
  const problems = checkNoDuplicatePatterns([
    update({
      groups: {
        angular: group({ patterns: ['@angular/*'] }),
        'angular-too': group({ patterns: ['@angular/*'] }),
      },
    }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /appears in multiple version-updates groups/);
});

test('checkNoDuplicatePatterns allows the same pattern across different paths', () => {
  // A version group and its security mirror necessarily share patterns.
  assert.deepEqual(checkNoDuplicatePatterns([angularPair()]), []);
});

// ---------------------------------------------------------------------------
// E2: family exclusions from generic buckets
// ---------------------------------------------------------------------------

test('checkFamilyExclusions flags a peer-locked family missing from dev-minor', () => {
  const entry = update({
    groups: {
      vitest: group({ patterns: ['vitest', '@vitest/*'] }),
      'dev-minor': group({ 'dependency-type': 'development', 'exclude-patterns': [] }),
    },
  });
  const policy = {
    'npm:/': {
      vitest: { kind: 'peer-locked', security: 'inert', rationale: 'x' },
      'dev-minor': { kind: 'generic', security: 'inert', rationale: 'x' },
    },
  };
  const problems = checkFamilyExclusions([entry], policy, ['dev-minor']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\[vitest, @vitest\/\*\] not\n\s+excluded/);
  assert.match(problems[0], /#533/);
});

test('checkFamilyExclusions treats a glob exclude as covering narrower patterns', () => {
  // `@angular/*` in dev-minor already covers the material group's
  // `@angular/material` / `@angular/cdk`. Demanding literal duplicates would
  // force no-op config.
  const entry = update({
    groups: {
      material: group({ patterns: ['@angular/material', '@angular/cdk'] }),
      'dev-minor': group({
        'dependency-type': 'development',
        'exclude-patterns': ['@angular/*'],
      }),
    },
  });
  const policy = {
    'npm:/': {
      material: { kind: 'peer-locked', security: 'inert', rationale: 'x' },
      'dev-minor': { kind: 'generic', security: 'inert', rationale: 'x' },
    },
  };
  assert.deepEqual(checkFamilyExclusions([entry], policy, ['dev-minor']), []);
});

test('checkFamilyExclusions ignores release-train groups', () => {
  // @azure/* are production-typed and not peer-locked, so a dev-scoped
  // generic bucket can never claim them.
  const entry = update({
    directory: '/api',
    groups: {
      'azure-sdk': group({ patterns: ['@azure/*'] }),
      'dev-minor': group({ 'dependency-type': 'development' }),
    },
  });
  const policy = {
    'npm:/api': {
      'azure-sdk': { kind: 'release-train', security: 'inert', rationale: 'x' },
      'dev-minor': { kind: 'generic', security: 'inert', rationale: 'x' },
    },
  };
  assert.deepEqual(checkFamilyExclusions([entry], policy, ['dev-minor']), []);
});

test('wildcardMatch mirrors dependabot WildcardMatcher semantics', () => {
  assert.ok(wildcardMatch('@angular/*', '@angular/material'));
  assert.ok(wildcardMatch('@angular/*', '@ANGULAR/Material'), 'matching is case-insensitive');
  assert.ok(!wildcardMatch('@angular/*', '@angular-devkit/core'));
  assert.ok(wildcardMatch('vitest', 'vitest'));
  assert.ok(!wildcardMatch('vitest', 'vitest-angular'));
});

test('isPatternExcluded handles literal and glob coverage', () => {
  assert.ok(isPatternExcluded('vitest', ['vitest']));
  assert.ok(isPatternExcluded('@vitest/*', ['@vitest/*']));
  assert.ok(isPatternExcluded('@angular/material', ['@angular/*']));
  assert.ok(!isPatternExcluded('playwright', ['@angular/*']));
});

// ---------------------------------------------------------------------------
// E3: PEER_LOCKED_FAMILIES cross-check
// ---------------------------------------------------------------------------

test('checkPeerLockedFamilySync flags a family no group claims', () => {
  const problems = checkPeerLockedFamilySync(
    [update({ groups: { angular: group({ patterns: ['@angular/*'] }) } })],
    [{ name: 'orphan', workspace: 'root', declared: ['orphan'] }],
    { 'npm:/': { angular: { kind: 'peer-locked', families: ['angular'] } } },
  );
  assert.ok(problems.some((problem) => /no GROUP_POLICY group lists it in/.test(problem)));
});

test('checkPeerLockedFamilySync flags a policy group missing from dependabot.yml', () => {
  const problems = checkPeerLockedFamilySync(
    [update({ groups: {} })],
    [{ name: 'vitest', workspace: 'root', declared: ['vitest'] }],
    { 'npm:/': { vitest: { kind: 'peer-locked', families: ['vitest'] } } },
  );
  assert.ok(problems.some((problem) => /no group of that name exists in/.test(problem)));
});

test('checkPeerLockedFamilySync flags a peer-locked group with no families list', () => {
  const problems = checkPeerLockedFamilySync(
    [update({ groups: { angular: group({ patterns: ['@angular/*'] }) } })],
    [],
    { 'npm:/': { angular: { kind: 'peer-locked' } } },
  );
  assert.ok(problems.some((problem) => /has no `families` list/.test(problem)));
});

test('checkPeerLockedFamilySync flags a group naming a family that does not exist', () => {
  const problems = checkPeerLockedFamilySync(
    [update({ groups: { angular: group({ patterns: ['@angular/*'] }) } })],
    [{ name: 'angular', workspace: 'root', declared: ['@angular/core'] }],
    { 'npm:/': { angular: { kind: 'peer-locked', families: ['angular', 'angular-tooling'] } } },
  );
  assert.ok(problems.some((problem) => /no\n {4}such entry exists/.test(problem)));
});

// The regression that motivated making `families` explicit rather than
// inferring the group from the family name. With an inferred mapping, the
// surviving co-grouped family still satisfies the group -> family direction,
// so deleting its sibling is silent and ten packages lose their assertion.
test('deleting one of two co-grouped families is loud, not silent', () => {
  const policy = {
    'npm:/': { angular: { kind: 'peer-locked', families: ['angular', 'angular-tooling'] } },
  };
  const updates = [update({ groups: { angular: group({ patterns: ['@angular/*'] }) } })];

  const both = [
    { name: 'angular', workspace: 'root', declared: ['@angular/core'] },
    { name: 'angular-tooling', workspace: 'root', declared: ['@angular/cli'] },
  ];
  assert.deepEqual(checkPeerLockedFamilySync(updates, both, policy), []);

  const survivorOnly = both.filter((family) => family.name !== 'angular');
  const problems = checkPeerLockedFamilySync(updates, survivorOnly, policy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /lists family 'angular' in/);
});

test('checkPeerLockedFamilySync flags a family claimed by two groups', () => {
  const problems = checkPeerLockedFamilySync(
    [update({ groups: { angular: group({ patterns: ['@angular/*'] }) } })],
    [{ name: 'angular', workspace: 'root', declared: ['@angular/core'] }],
    {
      'npm:/': {
        angular: { kind: 'peer-locked', families: ['angular'] },
        other: { kind: 'peer-locked', families: ['angular'] },
      },
    },
  );
  assert.ok(problems.some((problem) => /claimed by more than one group/.test(problem)));
});

test('checkPeerLockedFamilySync flags an unknown workspace', () => {
  const problems = checkPeerLockedFamilySync(
    [update()],
    [{ name: 'x', workspace: 'nowhere', declared: [] }],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unknown workspace/);
});

// Prevention and detection must describe the same set. The committed config
// is the live proof that the angular group covers both Angular cohorts.
test('the angular group covers both Angular cohorts', () => {
  assert.deepEqual(GROUP_POLICY['npm:/'].angular.families, ['angular', 'angular-tooling']);
  const families = PEER_LOCKED_FAMILIES.filter((family) =>
    GROUP_POLICY['npm:/'].angular.families.includes(family.name),
  );
  assert.equal(families.length, 2);
  // The tooling cohort tracks the framework's major but not its patch.
  const tooling = families.find((family) => family.name === 'angular-tooling');
  assert.equal(tooling.sharesMajorWith, 'angular');
});

// ---------------------------------------------------------------------------
// Live repo
// ---------------------------------------------------------------------------

test('the committed .github/dependabot.yml passes every assertion', () => {
  const problems = checkDependabotConfig(readFileSync(DEPENDABOT_CONFIG, 'utf8'));
  assert.deepEqual(problems, [], `committed config should pass:\n${problems.join('\n')}`);
});

test('the committed config declares a security counterpart for the angular group', () => {
  // The regression #506 is about. If someone deletes angular-security, the
  // GROUP_POLICY check fires -- but assert the shipped intent directly too.
  const { updates } = parseConfig(readFileSync(DEPENDABOT_CONFIG, 'utf8'));
  const root = updates.find((entry) => ecosystemKey(entry) === 'npm:/');
  const securityGroup = root.groups['angular-security'];
  assert.ok(securityGroup, 'angular-security group must exist');
  assert.equal(securityGroup['applies-to'], 'security-updates');
  assert.equal(
    securityGroup['update-types'],
    undefined,
    'security groups must not carry update-types',
  );
});

test('every committed ignore entry is update-types scoped, so none suppresses security', () => {
  const { updates } = parseConfig(readFileSync(DEPENDABOT_CONFIG, 'utf8'));
  for (const entry of updates) {
    for (const ignore of entry.ignore ?? []) {
      assert.equal(
        ignore.versions,
        undefined,
        `${ecosystemKey(entry)}: ignore for ${ignore['dependency-name']} carries versions:, ` +
          'which suppresses security updates',
      );
    }
  }
});
