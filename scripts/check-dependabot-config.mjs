#!/usr/bin/env node
// Structural gate for `.github/dependabot.yml`. Closes issue #536.
//
// Motivating incident: issue #506. The `angular` group bundles the
// peer-locked Angular family into one PR so a release lands as one mergeable
// change -- and a comment in the file said exactly that. But `groups.*
// .applies-to` defaults to `version-updates` when omitted, so the group never
// applied to security updates. Four Angular security advisories therefore
// produced four single-package PRs (#468-#471), every one of them unmergeable
// at `npm ci` because the runtime peer-locks with EXACT pins.
//
// The defect was an invisible default contradicting a visible comment. That
// is the class this gate exists to make loud: the file's correctness is
// otherwise unobservable until the next Monday 06:00 run.
//
// Five assertions:
//
//   A. Every group declares an explicit `applies-to`. The default is not
//      wrong, but it is invisible, and #506 is what invisible costs.
//
//   B. No `security-updates` group carries `update-types`. This is
//      structural, not a workaround for a transient upstream state:
//        - On the VERSION path, `checker.latest_version` is ignore-filtered,
//          so `update-types` composes with an `ignore` and behaves sensibly.
//        - On the SECURITY path, ignores are inert
//          (`ignore_condition.rb`: `return versions if security_updates_only`),
//          so `latest_version` can NEVER be lowered by config -- while
//          `semver_rules_allow_grouping?` compares against it with no
//          security-mode branch (the adjacent `all_versions_ignored?` DOES
//          branch, so the asymmetry is deliberate upstream).
//      Net: `update-types` on a security group cannot express "patch only"
//      whenever a newer major exists on the registry. It silently ejects the
//      package into an individual PR -- reproducing #506. GitHub's own
//      documented Example 4 gets this wrong; do not copy it.
//
//   C. Every group is classified in GROUP_POLICY with a `kind`, a `security`
//      posture, and a rationale. Deliberately NOT "every version group must
//      have a security counterpart": for vitest and playwright such a group
//      would be inert (their vulnerable members are transitive and
//      exact-pinned by a parent, so the security updater cannot remediate
//      them standalone), and a rule that mandates inert config is ceremony.
//      Naming the posture is the forcing function instead -- the
//      `knip.jsonc` / OVERRIDE_POLICY idiom.
//
//   D. Every `ignore` entry is classified in IGNORE_POLICY. The two forms of
//      `ignore` have OPPOSITE security semantics behind near-identical
//      syntax:
//
//        | entry                 | version updates | security updates |
//        | `update-types:` only  | suppressed      | NOT suppressed   |
//        | `versions:` present   | suppressed      | SUPPRESSED       |
//
//      An entry carrying `versions:` can therefore mask a live advisory, so
//      it must additionally set `suppressesSecurity: true` -- making the
//      dangerous form impossible to add silently.
//
//   E. Cross-checks against the rest of the repo:
//        - every `kind: 'peer-locked'` group's patterns are excluded from the
//          generic `dev-minor` / `dev-security` groups, so members cannot
//          route to the wrong bucket (#536). Scoped to peer-locked because
//          the generic buckets are dependency-type: development and can never
//          claim a production-typed family -- requiring a decorative
//          exclusion there would train contributors to add no-op lines;
//        - no pattern appears in two groups with the same `applies-to`,
//          which would emit duplicate PRs (dependabot-core #14576 reports
//          specificity matching overriding documented first-match-wins
//          ordering, so order is not a safe tiebreak);
//        - version/security sibling groups agree on `exclude-patterns`;
//        - PEER_LOCKED_FAMILIES in check-lockfile.mjs and the peer-locked
//          groups here stay in sync, bidirectionally. This mirrors the
//          OVERRIDE_POLICY <-> VENDORED_PACKAGES cross-check in
//          check-dependency-overrides.mjs: prevention (the group) and
//          detection (the lockstep assertion) must describe the same family.
//
// NOT asserted: rationale comments. `js-yaml` discards comments, a raw-text
// scan desynchronizes from the parse under `prettier`, and the committed
// file's rationale blocks sit above the `ignore:` key rather than above each
// entry. GROUP_POLICY and IGNORE_POLICY are the structured replacement --
// same reason check-dependency-overrides.mjs uses a registry rather than
// grepping for comments.
//
// Structural ceiling: this validates the config file, not GitHub's behavior.
// Proving Dependabot acts on it requires observing a real run -- the same
// ceiling check-swa-config.mjs documents for itself. Issue #535 (scheduled
// alert-to-PR coverage auditor) is the runtime half.
//
// Runs with zero new dependencies on Node 24+. Invoke directly or via:
//   npm run lint:dependabot-config
//   node scripts/check-dependabot-config.mjs

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

import { PEER_LOCKED_FAMILIES } from './check-lockfile.mjs';

export const DEPENDABOT_CONFIG = '.github/dependabot.yml';

/** The only values `groups.*.applies-to` accepts. */
export const APPLIES_TO_VALUES = Object.freeze(['version-updates', 'security-updates']);

/**
 * Generic catch-all groups. Family groups must be excluded from these, or a
 * family member can route to the generic bucket instead of its own group --
 * which is how the @vitest/* bumps were silently dropped in #533.
 */
export const GENERIC_GROUP_NAMES = Object.freeze(['dev-minor', 'dev-security']);

/**
 * Every group in the config, with its security posture and why.
 *
 * `security` is one of:
 *   - 'mirrored'  -- a security counterpart exists. `mirror` names it (the
 *                    name is not derivable: dev-minor's counterpart is
 *                    dev-security, not dev-minor-security). The gate asserts
 *                    it exists and that the two agree on exclude-patterns.
 *   - 'inert'     -- a security counterpart would never fire. Requires a
 *                    reason naming the mechanism.
 *   - 'is-mirror' -- this group IS the security counterpart of another.
 *
 * `kind` is one of:
 *   - 'peer-locked' -- members peer-depend at exact versions. Requires a
 *                      matching PEER_LOCKED_FAMILIES entry (detection half)
 *                      and exclusion from any generic group that could
 *                      otherwise claim a member.
 *   - 'release-train' -- members ship together but resolve independently, so
 *                      a partial bump still installs. Grouped for review
 *                      ergonomics, not correctness.
 *   - 'generic'     -- a catch-all bucket, scoped by dependency-type.
 *
 * Adding a group without an entry here fails the gate. Naming the specific
 * mechanism is the forcing function (cf. knip.jsonc, OVERRIDE_POLICY).
 */
export const GROUP_POLICY = {
  'npm:/': {
    angular: {
      kind: 'peer-locked',
      security: 'mirrored',
      mirror: 'angular-security',
      rationale:
        'Angular runtime + devkit peer-lock at exact versions, so a partial bump cannot install. The version group is the only vehicle that delivers a mergeable lockstep bump.',
    },
    'angular-security': {
      kind: 'peer-locked',
      security: 'is-mirror',
      mirrorOf: 'angular',
      rationale:
        'Consolidates N single-package Angular security PRs into one. Consolidation only: a security job filters membership to alerted packages, so the grouped PR still leaves un-alerted cluster members behind and fails npm ci. An alarm, not a fix -- see docs/supply-chain.md.',
    },
    material: {
      kind: 'peer-locked',
      security: 'mirrored',
      mirror: 'material-security',
      rationale:
        '@angular/material peers @angular/cdk at an exact version. Separate release cadence from the Angular runtime, hence a separate group. Production-typed, so the dev-* generic buckets cannot claim it and no exclusion is required.',
    },
    'material-security': {
      kind: 'peer-locked',
      security: 'is-mirror',
      mirrorOf: 'material',
      rationale:
        'Same consolidation-not-remediation caveat as angular-security: an alert on only one of the material/cdk pair cannot install standalone.',
    },
    vitest: {
      kind: 'peer-locked',
      security: 'inert',
      rationale:
        'A vitest-security group would never fire. The vulnerable member (@vitest/browser, #533) is transitive and pinned exactly by its parent, so the security updater cannot open a standalone PR for it; remediation can only ride a version update. Recorded rather than satisfied with an empty group.',
    },
    playwright: {
      kind: 'peer-locked',
      security: 'inert',
      rationale:
        'Same shape as vitest: @playwright/test depends on playwright at an exact version, which pins playwright-core exactly. An alerted child cannot be remediated standalone by the security updater.',
    },
    'dev-minor': {
      kind: 'generic',
      security: 'mirrored',
      mirror: 'dev-security',
      rationale:
        'Generic catch-all for dev-typed packages not in a family group. Carries update-types (minor+patch) because a version-path group composes correctly with the ignore entries.',
    },
    'dev-security': {
      kind: 'generic',
      security: 'is-mirror',
      mirrorOf: 'dev-minor',
      rationale:
        'The one genuinely mergeable consolidation here: dev-scoped packages are not peer-locked, so a partial bump resolves. Note dependency-type: development follows Dependabot Dependency#production?, which classifies metadata-less transitives as production -- so dev-in-reality packages like undici and brace-expansion are not claimed by it.',
    },
  },
  'npm:/api': {
    'azure-sdk': {
      kind: 'release-train',
      security: 'mirrored',
      mirror: 'azure-sdk-security',
      rationale:
        '@azure/* packages are released together and are the api workspace runtime surface. NOT peer-locked -- they peer each other on caret ranges, so a partial bump still installs and no PEER_LOCKED_FAMILIES assertion is needed. Production-typed, so the dev-* buckets cannot claim them.',
    },
    'azure-sdk-security': {
      kind: 'release-train',
      security: 'is-mirror',
      mirrorOf: 'azure-sdk',
      rationale:
        'Unlike the angular/material counterparts this one is genuinely mergeable: @azure/* peer each other on caret ranges, not exact pins.',
    },
    'dev-minor': {
      kind: 'generic',
      security: 'mirrored',
      mirror: 'dev-security',
      rationale: 'Generic catch-all for dev-typed packages in the api workspace.',
    },
    'dev-security': {
      kind: 'generic',
      security: 'is-mirror',
      mirrorOf: 'dev-minor',
      rationale: 'Security counterpart to the api dev-minor group; same reasoning as root.',
    },
  },
};

/**
 * Ecosystems that intentionally define no groups. Registered so a newly-added
 * ecosystem cannot silently skip grouping.
 */
export const UNGROUPED_ECOSYSTEMS = {
  'github-actions:/': {
    rationale:
      'Action version bumps are independent of one another -- no peer locking, no shared release train -- so per-action PRs are the correct granularity.',
  },
};

/**
 * Every `ignore` entry, keyed by ecosystem then dependency-name.
 *
 * `suppressesSecurity` MUST be true for any entry carrying a `versions:` key,
 * and MUST be false for an `update-types`-only entry. The gate asserts both
 * directions, so the security-suppressing form cannot be added by accident.
 */
export const IGNORE_POLICY = {
  'npm:/': {
    '@types/node': {
      suppressesSecurity: false,
      blockingIssue: null,
      rationale:
        'Tracks the Node major we develop and test against (Node 24 via .nvmrc / engines.node). Revisit at the next LTS.',
    },
    vitest: {
      suppressesSecurity: false,
      blockingIssue: '#533',
      rationale:
        'Vitest family capped at 4.x by @analogjs/vitest-angular, which peers vitest ^4.0.0 and cannot be grouped with it. Lift once Analog admits vitest 5.',
    },
    '@vitest/*': {
      suppressesSecurity: false,
      blockingIssue: '#533',
      rationale: 'Same @analogjs/vitest-angular peer cap as the vitest entry.',
    },
    '@angular/*': {
      suppressesSecurity: false,
      blockingIssue: '#550',
      rationale:
        'Angular 22 requires TypeScript 6; repo pins typescript ~5.9.3. An ungated major also starves the 21.2.x patch train, because version updates always target latest_version and ignore is the only key that lowers it. Also freezes material/cdk majors -- ignore has no exclude-patterns.',
    },
    '@angular-devkit/build-angular': {
      suppressesSecurity: false,
      blockingIssue: '#550',
      rationale:
        'Angular 22 / TypeScript 6, as @angular/*. Enumerated rather than globbed because @angular-devkit/architect and /build-webpack version as 0.2102.x, where ignored_major_versions emits ">= 1.a" and gates nothing.',
    },
    '@angular-devkit/core': {
      suppressesSecurity: false,
      blockingIssue: '#550',
      rationale: 'Angular 22 / TypeScript 6, as @angular/*.',
    },
    '@angular-devkit/schematics': {
      suppressesSecurity: false,
      blockingIssue: '#550',
      rationale: 'Angular 22 / TypeScript 6, as @angular/*.',
    },
  },
  'npm:/api': {
    '@types/node': {
      suppressesSecurity: false,
      blockingIssue: null,
      rationale: 'Tracks the Node major we develop and test against. Same as root.',
    },
    'jwks-rsa': {
      suppressesSecurity: false,
      blockingIssue: null,
      rationale:
        "v4 upgrades to jose v6, which is ESM-only; Jest's vm.Script runtime cannot parse it. See api/src/shared/auth.ts. Lift when Jest stabilizes require(esm) or jose ships CJS.",
    },
  },
};

/** Stable `<ecosystem>:<directory>` key for an `updates` entry. */
export function ecosystemKey(update) {
  return `${update['package-ecosystem']}:${update.directory ?? '/'}`;
}

/**
 * Mirrors dependabot-core's `WildcardMatcher`: `*` is the only metacharacter
 * and matching is case-insensitive (`update_config.rb` lowercases both sides).
 *
 * Needed because exclusion is a *glob* relation, not string equality: the
 * exclude-pattern `@angular/*` already covers the `material` group's
 * `@angular/material` and `@angular/cdk` patterns. Comparing literally would
 * demand redundant config -- and a gate that forces no-op lines teaches
 * contributors to add no-op lines.
 */
export function wildcardMatch(pattern, name) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

/**
 * True when `pattern` is covered by some entry of `excludes` -- either
 * literally, or because an exclude glob subsumes it.
 *
 * Subsumption is tested by treating the candidate pattern as a name and
 * matching it against each exclude. That is exact for literals and for the
 * `prefix/*` shape this config uses; it does not attempt full glob-algebra
 * containment, which npm scope patterns never need.
 */
export function isPatternExcluded(pattern, excludes) {
  return excludes.some(
    (exclude) => exclude === pattern || wildcardMatch(exclude, pattern.replace(/\*$/, '')),
  );
}

/**
 * Parses the config. Returns `{ updates, error }` -- `error` is a string when
 * the file is missing or structurally unusable, in which case `updates` is [].
 */
export function parseConfig(text) {
  let parsed;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { updates: [], error: `failed to parse ${DEPENDABOT_CONFIG} as YAML: ${message}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { updates: [], error: `${DEPENDABOT_CONFIG} did not parse to an object.` };
  }
  if (!Array.isArray(parsed.updates)) {
    return { updates: [], error: `${DEPENDABOT_CONFIG} has no top-level \`updates\` array.` };
  }
  return { updates: parsed.updates, error: null };
}

/** A: every group declares an explicit `applies-to`, with a valid value. */
export function checkExplicitAppliesTo(updates) {
  const problems = [];
  for (const update of updates) {
    const key = ecosystemKey(update);
    for (const [name, group] of Object.entries(update.groups ?? {})) {
      const appliesTo = group?.['applies-to'];
      if (appliesTo === undefined) {
        problems.push(
          `${key}: group '${name}' does not declare \`applies-to\`.\n` +
            `    It defaults to 'version-updates', so security updates bypass the group\n` +
            `    entirely and arrive one-per-package. That invisible default is issue #506.\n` +
            `    Add \`applies-to: version-updates\` (or 'security-updates') explicitly.`,
        );
        continue;
      }
      if (!APPLIES_TO_VALUES.includes(appliesTo)) {
        problems.push(
          `${key}: group '${name}' has \`applies-to: ${appliesTo}\`, which is not one of ` +
            `${APPLIES_TO_VALUES.join(' / ')}.`,
        );
      }
    }
  }
  return problems;
}

/** B: no `security-updates` group carries `update-types`. */
export function checkNoUpdateTypesOnSecurityGroups(updates) {
  const problems = [];
  for (const update of updates) {
    const key = ecosystemKey(update);
    for (const [name, group] of Object.entries(update.groups ?? {})) {
      if (group?.['applies-to'] !== 'security-updates') continue;
      if (group['update-types'] === undefined) continue;
      problems.push(
        `${key}: security group '${name}' carries \`update-types\`, which is structurally\n` +
          `    broken on the security path. \`semver_rules_allow_grouping?\` compares against\n` +
          `    \`checker.latest_version\`, and security-path ignores are inert, so latest_version\n` +
          `    can never be lowered by config. Any package whose newest release is a major ahead\n` +
          `    is silently ejected from the group into an individual PR -- reproducing #506.\n` +
          `    Remove \`update-types\`; for a security fix you want the patch regardless of shape.\n` +
          `    (GitHub's documented Example 4 shows this pattern. It is wrong.)`,
      );
    }
  }
  return problems;
}

/** C: every group classified in GROUP_POLICY; mirrors exist and agree. */
export function checkGroupPolicy(updates, policy = GROUP_POLICY, ungrouped = UNGROUPED_ECOSYSTEMS) {
  const problems = [];
  const seenKeys = new Set();

  for (const update of updates) {
    const key = ecosystemKey(update);
    seenKeys.add(key);
    const groups = update.groups ?? {};
    const groupNames = Object.keys(groups);
    const entries = policy[key];

    if (groupNames.length === 0) {
      if (!ungrouped[key]) {
        problems.push(
          `${key}: defines no groups and is not registered in UNGROUPED_ECOSYSTEMS.\n` +
            `    Add an entry with a rationale, or add groups. A new ecosystem must not be able\n` +
            `    to skip grouping silently.`,
        );
      } else if (!ungrouped[key].rationale) {
        problems.push(`${key}: UNGROUPED_ECOSYSTEMS entry has no rationale.`);
      }
      continue;
    }

    if (!entries) {
      problems.push(
        `${key}: has groups but no GROUP_POLICY entry. Add one classifying each group's\n` +
          `    security posture ('mirrored' / 'inert' / 'is-mirror') with a rationale.`,
      );
      continue;
    }

    for (const name of groupNames) {
      const entry = entries[name];
      if (!entry) {
        problems.push(
          `${key}: group '${name}' is not classified in GROUP_POLICY.\n` +
            `    Add { security: 'mirrored' | 'inert' | 'is-mirror', rationale: '...' } naming\n` +
            `    the specific mechanism -- the same forcing function knip.jsonc and\n` +
            `    OVERRIDE_POLICY use.`,
        );
        continue;
      }
      if (!entry.rationale) {
        problems.push(`${key}: GROUP_POLICY entry for '${name}' has no rationale.`);
      }
      if (!['peer-locked', 'release-train', 'generic'].includes(entry.kind)) {
        problems.push(
          `${key}: GROUP_POLICY entry for '${name}' has kind '${entry.kind}', which is not one\n` +
            `    of peer-locked / release-train / generic.`,
        );
      }
      if (!['mirrored', 'inert', 'is-mirror'].includes(entry.security)) {
        problems.push(
          `${key}: GROUP_POLICY entry for '${name}' has security '${entry.security}',\n` +
            `    which is not one of mirrored / inert / is-mirror.`,
        );
        continue;
      }

      const group = groups[name];
      if (entry.security === 'mirrored') {
        if (group?.['applies-to'] !== 'version-updates') {
          problems.push(
            `${key}: group '${name}' is classified 'mirrored' but is not a version-updates group.`,
          );
        }
        const mirrorName = entry.mirror;
        if (!mirrorName) {
          problems.push(
            `${key}: GROUP_POLICY entry for '${name}' is 'mirrored' but has no \`mirror\` naming\n` +
              `    its security counterpart.`,
          );
        } else if (!groups[mirrorName]) {
          problems.push(
            `${key}: group '${name}' is classified 'mirrored' but '${mirrorName}' does not exist.\n` +
              `    Add it, or reclassify as 'inert' with a reason naming why a security\n` +
              `    counterpart would never fire.`,
          );
        } else {
          problems.push(
            ...compareExcludePatterns(key, name, group, mirrorName, groups[mirrorName]),
          );
        }
      }

      if (entry.security === 'is-mirror') {
        if (group?.['applies-to'] !== 'security-updates') {
          problems.push(
            `${key}: group '${name}' is classified 'is-mirror' but is not a security-updates group.`,
          );
        }
        if (!entry.mirrorOf) {
          problems.push(
            `${key}: GROUP_POLICY entry for '${name}' is 'is-mirror' but has no mirrorOf.`,
          );
        } else if (!groups[entry.mirrorOf]) {
          problems.push(
            `${key}: GROUP_POLICY says '${name}' mirrors '${entry.mirrorOf}', which does not exist.`,
          );
        } else if (entries[entry.mirrorOf]?.mirror !== name) {
          problems.push(
            `${key}: '${name}' claims to mirror '${entry.mirrorOf}', but that group's \`mirror\`\n` +
              `    is '${entries[entry.mirrorOf]?.mirror ?? '(unset)'}'. The relation must agree\n` +
              `    in both directions.`,
          );
        }
      }

      if (entry.security === 'inert' && groups[`${name}-security`]) {
        problems.push(
          `${key}: group '${name}' is classified 'inert' but '${name}-security' exists.\n` +
            `    Either the classification is stale or the group should be removed.`,
        );
      }
    }

    for (const name of Object.keys(entries)) {
      if (!groupNames.includes(name)) {
        problems.push(
          `${key}: GROUP_POLICY classifies '${name}', which no longer exists in the config.\n` +
            `    Remove the stale entry.`,
        );
      }
    }
  }

  for (const key of Object.keys(policy)) {
    if (!seenKeys.has(key)) {
      problems.push(`GROUP_POLICY has an entry for '${key}', which is not in the config.`);
    }
  }
  for (const key of Object.keys(ungrouped)) {
    if (!seenKeys.has(key)) {
      problems.push(`UNGROUPED_ECOSYSTEMS has an entry for '${key}', which is not in the config.`);
    }
  }

  return problems;
}

/** A version group and its security mirror must carve out the same packages. */
function compareExcludePatterns(key, name, group, mirrorName, mirror) {
  const left = [...(group?.['exclude-patterns'] ?? [])].sort();
  const right = [...(mirror?.['exclude-patterns'] ?? [])].sort();
  if (left.length === right.length && left.every((value, index) => value === right[index])) {
    return [];
  }
  return [
    `${key}: '${name}' and '${mirrorName}' disagree on exclude-patterns.\n` +
      `    ${name}: [${left.join(', ') || '(none)'}]\n` +
      `    ${mirrorName}: [${right.join(', ') || '(none)'}]\n` +
      `    A package carved out of one but not the other routes differently depending on\n` +
      `    which path (version vs security) triggered the run.`,
  ];
}

/** D: every `ignore` entry classified; the security-suppressing form flagged. */
export function checkIgnorePolicy(updates, policy = IGNORE_POLICY) {
  const problems = [];
  const seen = new Map();

  for (const update of updates) {
    const key = ecosystemKey(update);
    const entries = update.ignore ?? [];
    const names = new Set();

    for (const entry of entries) {
      const name = entry?.['dependency-name'];
      if (!name) {
        problems.push(`${key}: an \`ignore\` entry has no \`dependency-name\`.`);
        continue;
      }
      names.add(name);

      const registered = policy[key]?.[name];
      if (!registered) {
        problems.push(
          `${key}: ignore entry '${name}' is not registered in IGNORE_POLICY.\n` +
            `    Add { suppressesSecurity, blockingIssue, rationale }. An ignore is a\n` +
            `    suppression; it needs a named unblock condition, not just a comment.`,
        );
        continue;
      }
      if (!registered.rationale) {
        problems.push(`${key}: IGNORE_POLICY entry for '${name}' has no rationale.`);
      }

      const hasVersions = Array.isArray(entry.versions) && entry.versions.length > 0;
      if (hasVersions && registered.suppressesSecurity !== true) {
        problems.push(
          `${key}: ignore entry '${name}' carries a \`versions:\` key but IGNORE_POLICY does not\n` +
            `    mark it \`suppressesSecurity: true\`.\n` +
            `    A \`versions:\` ignore DOES apply to security updates -- \`ignored_versions\`\n` +
            `    short-circuits with \`return versions if security_updates_only\` -- so this entry\n` +
            `    can mask a live advisory. Confirm that is intended and set the flag, or scope the\n` +
            `    entry with \`update-types\` instead, which never suppresses security updates.`,
        );
      }
      if (!hasVersions && registered.suppressesSecurity === true) {
        problems.push(
          `${key}: IGNORE_POLICY marks '${name}' as \`suppressesSecurity: true\`, but the entry\n` +
            `    carries no \`versions:\` key, so it does NOT suppress security updates.\n` +
            `    The claim overstates the risk -- set it to false.`,
        );
      }
    }

    seen.set(key, names);
  }

  for (const [key, registered] of Object.entries(policy)) {
    const names = seen.get(key);
    if (!names) {
      problems.push(`IGNORE_POLICY has entries for '${key}', which is not in the config.`);
      continue;
    }
    for (const name of Object.keys(registered)) {
      if (!names.has(name)) {
        problems.push(
          `${key}: IGNORE_POLICY registers '${name}', which is no longer ignored in the config.\n` +
            `    Remove the stale entry.`,
        );
      }
    }
  }

  return problems;
}

/** E1: no pattern appears in two groups sharing an `applies-to`. */
export function checkNoDuplicatePatterns(updates) {
  const problems = [];
  for (const update of updates) {
    const key = ecosystemKey(update);
    const byPattern = new Map();
    for (const [name, group] of Object.entries(update.groups ?? {})) {
      const appliesTo = group?.['applies-to'] ?? 'version-updates';
      for (const pattern of group?.patterns ?? []) {
        const mapKey = `${appliesTo}\u0000${pattern}`;
        if (!byPattern.has(mapKey)) byPattern.set(mapKey, []);
        byPattern.get(mapKey).push(name);
      }
    }
    for (const [mapKey, names] of byPattern) {
      if (names.length < 2) continue;
      const [appliesTo, pattern] = mapKey.split('\u0000');
      problems.push(
        `${key}: pattern '${pattern}' appears in multiple ${appliesTo} groups ` +
          `(${names.join(', ')}).\n` +
          `    A dependency is assigned to EVERY matching group, so this emits duplicate PRs.\n` +
          `    Ordering is not a safe tiebreak -- dependabot-core #14576 reports specificity\n` +
          `    matching overriding the documented first-match-wins rule.`,
      );
    }
  }
  return problems;
}

/**
 * E2: peer-locked family patterns are excluded from the generic catch-all
 * groups.
 *
 * Scoped to `kind: 'peer-locked'` for a reason. The generic buckets are
 * `dependency-type: development`, so they can only ever claim dev-typed
 * packages. A production-typed family (material, azure-sdk) cannot collide
 * with them, and requiring a decorative exclusion would train contributors to
 * add lines that do nothing. Peer-locked families are where a mis-route is
 * actually destructive -- #533 is the worked example.
 */
export function checkFamilyExclusions(
  updates,
  policy = GROUP_POLICY,
  genericNames = GENERIC_GROUP_NAMES,
) {
  const problems = [];
  for (const update of updates) {
    const key = ecosystemKey(update);
    const groups = update.groups ?? {};
    const entries = policy[key] ?? {};

    const generics = genericNames
      .filter((name) => groups[name])
      .map((name) => ({ name, excludes: groups[name]['exclude-patterns'] ?? [] }));
    if (generics.length === 0) continue;

    for (const [name, group] of Object.entries(groups)) {
      if (genericNames.includes(name)) continue;
      const entry = entries[name];
      if (entry?.kind !== 'peer-locked') continue;
      // A security mirror is covered by its version-path sibling's check.
      if (entry.security === 'is-mirror') continue;

      const patterns = group?.patterns ?? [];
      if (patterns.length === 0) continue;

      for (const generic of generics) {
        const missing = patterns.filter((pattern) => !isPatternExcluded(pattern, generic.excludes));
        if (missing.length === 0) continue;
        problems.push(
          `${key}: peer-locked family '${name}' has pattern(s) [${missing.join(', ')}] not\n` +
            `    excluded from generic group '${generic.name}'. Members can route to the generic\n` +
            `    bucket instead of their family group -- which is how the @vitest/* bumps were\n` +
            `    silently dropped in #533. Add them to ${generic.name}'s exclude-patterns.`,
        );
      }
    }
  }
  return problems;
}

/**
 * E3: PEER_LOCKED_FAMILIES and the config's family groups stay in sync, in
 * both directions.
 *
 * The two halves cover different inbound paths -- the group is *prevention*
 * (it shapes what Dependabot proposes), the lockstep assertion is *detection*
 * (it catches a partial bump from any source). Both must describe the same
 * family or the pair silently stops composing. Mirrors the
 * OVERRIDE_POLICY <-> VENDORED_PACKAGES cross-check.
 */
export function checkPeerLockedFamilySync(updates, families = PEER_LOCKED_FAMILIES) {
  const problems = [];
  const workspaceToKey = { root: 'npm:/', api: 'npm:/api' };

  for (const family of families) {
    const key = workspaceToKey[family.workspace];
    if (!key) {
      problems.push(
        `PEER_LOCKED_FAMILIES entry '${family.name}' has unknown workspace ` +
          `'${family.workspace}'; expected one of ${Object.keys(workspaceToKey).join(', ')}.`,
      );
      continue;
    }
    const update = updates.find((candidate) => ecosystemKey(candidate) === key);
    if (!update) {
      problems.push(
        `PEER_LOCKED_FAMILIES entry '${family.name}' targets workspace '${family.workspace}' ` +
          `(${key}), which has no matching \`updates\` entry.`,
      );
      continue;
    }
    if (!(update.groups ?? {})[family.name]) {
      problems.push(
        `${key}: PEER_LOCKED_FAMILIES declares family '${family.name}' in\n` +
          `    scripts/check-lockfile.mjs, but no group of that name exists here.\n` +
          `    docs/supply-chain.md requires all three of: a family group, a generic-group\n` +
          `    exclusion, and a PEER_LOCKED_FAMILIES assertion. Prevention and detection must\n` +
          `    describe the same family.`,
      );
    }
  }

  const familyNames = new Set(families.map((family) => family.name));
  for (const update of updates) {
    const key = ecosystemKey(update);
    const entries = GROUP_POLICY[key] ?? {};
    for (const [name, entry] of Object.entries(entries)) {
      // Only peer-locked families need the detection half. A release-train
      // group resolves fine after a partial bump, so a lockstep assertion
      // would be a false invariant.
      if (entry.kind !== 'peer-locked') continue;
      if (entry.security === 'is-mirror') continue;
      if (!(update.groups ?? {})[name]) continue;
      if (familyNames.has(name)) continue;
      problems.push(
        `${key}: group '${name}' is classified kind 'peer-locked' but has no\n` +
          `    PEER_LOCKED_FAMILIES entry in scripts/check-lockfile.mjs. Add the lockstep\n` +
          `    assertion (the detection half), or reclassify the group's kind if its members\n` +
          `    do not actually peer-lock at exact versions.`,
      );
    }
  }

  return problems;
}

export function checkDependabotConfig(text) {
  const { updates, error } = parseConfig(text);
  if (error) return [error];

  return [
    ...checkExplicitAppliesTo(updates),
    ...checkNoUpdateTypesOnSecurityGroups(updates),
    ...checkGroupPolicy(updates),
    ...checkIgnorePolicy(updates),
    ...checkNoDuplicatePatterns(updates),
    ...checkFamilyExclusions(updates),
    ...checkPeerLockedFamilySync(updates),
  ];
}

export function main() {
  if (!existsSync(DEPENDABOT_CONFIG)) {
    console.error(
      `check-dependabot-config: ${DEPENDABOT_CONFIG} not found. Run from the repository root.`,
    );
    return 2;
  }

  const problems = checkDependabotConfig(readFileSync(DEPENDABOT_CONFIG, 'utf8'));

  if (problems.length > 0) {
    console.error('');
    console.error('check-dependabot-config: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    console.error('  See docs/supply-chain.md -> "Grouped security updates" for the policy.');
    return 1;
  }

  const { updates } = parseConfig(readFileSync(DEPENDABOT_CONFIG, 'utf8'));
  const groupCount = updates.reduce(
    (total, update) => total + Object.keys(update.groups ?? {}).length,
    0,
  );
  const ignoreCount = updates.reduce((total, update) => total + (update.ignore ?? []).length, 0);
  console.log(
    `check-dependabot-config: OK (${groupCount} group(s) classified, ` +
      `${ignoreCount} ignore entry(s) justified)`,
  );
  return 0;
}

// Only invoke main() when executed directly. The unit test imports this module
// solely for its exports and must not trigger CLI side effects.
const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main());
}
