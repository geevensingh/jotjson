#!/usr/bin/env node
// Dependency-override policy gate.
//
// Motivating incident: issue #514. Root `package.json` carried
// `"overrides": { "dompurify": "3.4.1" }`. That pin forced the *installed*
// dompurify to 3.4.1, but nothing in the shipped bundle ever imported it:
// `angular.json` copies `node_modules/monaco-editor/min/vs` wholesale to
// `/vs`, and Monaco *vendors* its own DOMPurify inside that prebuilt bundle
// (3.2.7 at monaco-editor@0.55.1). The pin therefore described a package
// that never ships.
//
// Two consequences, both bad:
//
//   (a) It offered a one-line "fix" for 10 Dependabot alerts that would have
//       changed zero shipped bytes -- converting a visible signal into a
//       silent one.
//   (b) Worse, it actively SUPPRESSED true findings. Eight dompurify
//       advisories cover the shipped 3.2.7 but not the pinned 3.4.1 (all
//       with ranges below 3.4.0), so the pin under-reported the shipped
//       artifact by eight advisories.
//
// This gate makes both failure modes loud. It has two parts:
//
//   Part A -- every entry in root `overrides` must be classified and
//             justified in OVERRIDE_POLICY below: a classification, a named
//             consumer, and a rationale, for every classification. This
//             mirrors the `knip.jsonc` allowlist idiom: adding an entry
//             requires naming a specific mechanism, which is the forcing
//             function.
//
//   Part B -- for every package known to ship vendored inside a prebuilt
//             asset (VENDORED_PACKAGES), read the version out of the bytes
//             we actually ship, corroborate it against the vendoring
//             package's own sources, and assert that no override contradicts
//             it.
//
// The two registries are also cross-checked against each other in both
// directions (see checkPolicyVendoredConsistency), because a classification
// that disagrees with the vendored registry can otherwise slip between the
// two parts.
//
// Part B reads the version from the *minified* tree that `angular.json`
// actually copies -- not from the ESM tree. Both are checked and must agree,
// but the shipped tree is authoritative. (Monaco's minifier strips the
// `@license` banner as of 0.56.0, but a `version="x.y.z"` literal survives in
// both 0.55.1 and 0.56.0, so the shipped bytes remain readable.)
//
// The gate FAILS CLOSED throughout: a missing version literal, a changed
// asset mapping, an ambiguous match, or a disagreement between sources all
// fail loudly rather than silently going stale.
//
// Runs with zero dependencies on Node 24+. Invoke directly or via:
//   npm run lint:dependency-overrides

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Classification + justification for every entry in root `overrides`.
 *
 * Classifications:
 *   'dev-only'         - nothing this pins ever reaches a user. The pin is
 *                        honest because it only constrains build tooling.
 *   'prod-graph'       - ships via the Angular build graph, so the pin
 *                        genuinely controls shipped bytes.
 *   'shipped-prebuilt' - the package ships vendored inside a prebuilt asset,
 *                        so the pin does NOT control shipped bytes. Must also
 *                        appear in VENDORED_PACKAGES, and Part B will require
 *                        the pin to equal the vendored version.
 *
 * `consumer` must name the SPECIFIC package(s) that depend on the overridden
 * package -- not a generic "build tooling". If you cannot name one, the
 * override is probably unnecessary.
 */
export const OVERRIDE_POLICY = {
  '@babel/plugin-transform-modules-systemjs': {
    classification: 'dev-only',
    consumer: '@babel/preset-env',
    rationale:
      'Babel transform pulled in by @babel/preset-env during the Angular build. Compile-time only; no Babel runtime ships.',
  },
  'fast-uri': {
    classification: 'dev-only',
    consumer: 'ajv',
    rationale:
      'URI parser used by ajv for JSON-schema $ref resolution at build/config time. ajv is a devDependency; neither it nor fast-uri reaches the browser bundle.',
  },
  hono: {
    classification: 'dev-only',
    consumer: '@hono/node-server, @modelcontextprotocol/sdk',
    rationale:
      'HTTP framework used by dev-server tooling only. The deployed API is Azure Functions (api/ workspace), which does not depend on hono.',
  },
};

/**
 * Packages that ship vendored inside a prebuilt asset rather than through the
 * module graph. For each, the gate reads the version out of the shipped bytes
 * and asserts no override contradicts it.
 *
 * `assetInput` must match an `input` entry in angular.json's assets array --
 * the gate asserts this, so the check cannot silently detach if the asset
 * mapping is changed or removed.
 */
export const VENDORED_PACKAGES = [
  {
    package: 'dompurify',
    vendoredBy: 'monaco-editor',
    assetInput: 'node_modules/monaco-editor/min/vs',
    // Cheap pre-filter: only files containing this literal are parsed for a
    // version. Also doubles as a presence assertion -- zero matching files
    // means Monaco stopped vendoring DOMPurify (or moved it out of the tree
    // we copy), which invalidates every other assumption here.
    //
    // This marker survives minification. Monaco 0.56.0 strips the `@license`
    // banner COMMENT from min/vs, but the word DOMPurify remains in a Trusted
    // Types error string ("...must not call DOMPurify.sanitize, as that causes
    // infinite recursion..."), so the pre-filter still finds the chunk.
    // Verified against the published 0.55.1 and 0.56.0 tarballs.
    marker: 'DOMPurify',
    versionPatterns: [
      /@license\s+DOMPurify\s+(\d+\.\d+\.\d+)/g,
      /\bversion\s*=\s*"(\d+\.\d+\.\d+)"/g,
    ],
    // Corroborating sources. Must agree with the shipped tree.
    esmSource: 'node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js',
    esmPattern: /@license\s+DOMPurify\s+(\d+\.\d+\.\d+)/,
    declaringManifest: 'node_modules/monaco-editor/package.json',
  },
];

const VALID_CLASSIFICATIONS = new Set(['dev-only', 'prod-graph', 'shipped-prebuilt']);

/**
 * True only for a string with at least one non-whitespace character.
 *
 * Guards the justification fields: a truthy check alone would accept `'   '`,
 * `true`, or `42` as a "named consumer".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Strips a version selector from an npm override key.
 *
 * npm permits `"foo@2": "..."` to scope an override to matching versions.
 * Scoped package names start with `@`, so only an `@` at index > 0 is a
 * selector separator.
 *
 * @param {string} key
 * @returns {string}
 */
export function normalizePackageKey(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

function addOverride(map, name, value) {
  const existing = map.get(name);
  if (existing) existing.add(value);
  else map.set(name, new Set([value]));
}

/**
 * Flattens an npm `overrides` block into `Map<packageName, Set<targetValue>>`.
 *
 * Handles every documented form, because each can silence an alert:
 *   flat      { "dompurify": "3.4.14" }
 *   nested    { "monaco-editor": { "dompurify": "3.4.14" } }
 *   selector  { "dompurify@3.2.7": "3.4.14" }
 *   self      { "monaco-editor": { ".": "0.56.0" } }
 *
 * A nested object's key is a *scope selector*, not an overridden package, so
 * it is not itself recorded -- only the `.` form overrides the parent.
 *
 * Exported for unit testing.
 *
 * @param {unknown} overrides
 * @param {string[]} [path]
 * @returns {Map<string, Set<string>>}
 */
export function normalizeOverrides(overrides, path = []) {
  /** @type {Map<string, Set<string>>} */
  const result = new Map();
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return result;
  }
  for (const [rawKey, value] of Object.entries(overrides)) {
    if (rawKey === '.') {
      const parent = path[path.length - 1];
      if (parent && typeof value === 'string') addOverride(result, parent, value);
      continue;
    }
    const name = normalizePackageKey(rawKey);
    if (typeof value === 'string') {
      addOverride(result, name, value);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedName, values] of normalizeOverrides(value, [...path, name])) {
        for (const nestedValue of values) addOverride(result, nestedName, nestedValue);
      }
    }
  }
  return result;
}

/**
 * Part A: every override must be classified and justified.
 *
 * Exported for unit testing.
 *
 * @param {Map<string, Set<string>>} effective
 * @param {Record<string, {classification: string, consumer?: unknown, rationale?: unknown}>} policy
 * @returns {string[]} one message per violation; empty array means pass
 */
export function checkOverridePolicy(effective, policy) {
  const problems = [];
  for (const name of [...effective.keys()].sort()) {
    const entry = policy[name];
    if (!entry) {
      problems.push(
        `override '${name}' is not classified in OVERRIDE_POLICY (scripts/check-dependency-overrides.mjs).\n` +
          `    Add an entry classifying it as 'dev-only', 'prod-graph', or 'shipped-prebuilt',\n` +
          `    naming the specific package that depends on it and why the pin is needed.`,
      );
      continue;
    }
    if (!VALID_CLASSIFICATIONS.has(entry.classification)) {
      problems.push(
        `override '${name}' has unknown classification '${entry.classification}'. ` +
          `Expected one of: ${[...VALID_CLASSIFICATIONS].join(', ')}.`,
      );
    }
    // "Classified AND justified" applies to every classification, not just
    // dev-only. The prod-graph / shipped-prebuilt cases are the more
    // security-relevant ones, so exempting them would put the loophole in
    // exactly the wrong place.
    if (!isNonEmptyString(entry.consumer)) {
      problems.push(
        `override '${name}' (${entry.classification}) names no specific consumer.\n` +
          `    Name the package(s) that actually depend on '${name}'. If you cannot name one,\n` +
          `    the override is probably unnecessary.`,
      );
    }
    if (!isNonEmptyString(entry.rationale)) {
      problems.push(
        `override '${name}' (${entry.classification}) has no rationale.\n` +
          `    State why the pin is needed and why this classification is correct.`,
      );
    }
  }
  // A policy entry with no matching override is stale bookkeeping, not a
  // security problem -- but it should still be cleaned up.
  for (const name of Object.keys(policy).sort()) {
    if (!effective.has(name)) {
      problems.push(
        `OVERRIDE_POLICY lists '${name}' but root package.json has no such override. Remove the stale entry.`,
      );
    }
  }
  return problems;
}

/**
 * Cross-validates the two registries against each other, in BOTH directions.
 *
 * Part A (`checkOverridePolicy`) and Part B (`checkOverrideAgainstShipped`)
 * each look at one registry, so a classification that disagrees with reality
 * can slip between them:
 *
 *   Forward  - an override classified `shipped-prebuilt` that is NOT in
 *              VENDORED_PACKAGES never gets its shipped bytes read at all,
 *              because Part B iterates VENDORED_PACKAGES. The classification
 *              claims "this pin does not control what ships" and then nothing
 *              verifies what actually ships.
 *
 *   Converse - an override on a package that IS vendored, but classified as
 *              something else (say `dev-only`), passes Part A. Part B still
 *              runs, but `checkOverrideAgainstShipped` returns null whenever
 *              the pinned value happens to equal the shipped version -- so a
 *              materially false classification passes both parts today. That
 *              matters because the classification is what a human reads to
 *              decide whether bumping the pin is safe.
 *
 * Deliberately NOT enforced: a vendored package with no override needs no
 * policy entry. That absence is the desired steady state (issue #514) --
 * npm then resolves the package from the vendoring package's own declaration.
 *
 * Exported for unit testing.
 *
 * @param {Map<string, Set<string>>} effective
 * @param {Record<string, {classification: string}>} policy
 * @param {Iterable<string>} vendoredPackageNames
 * @returns {string[]} one message per violation; empty array means pass
 */
export function checkPolicyVendoredConsistency(effective, policy, vendoredPackageNames) {
  const problems = [];
  const vendored = new Set(vendoredPackageNames);

  for (const name of Object.keys(policy).sort()) {
    if (policy[name].classification !== 'shipped-prebuilt') continue;
    if (!vendored.has(name)) {
      problems.push(
        `OVERRIDE_POLICY classifies '${name}' as 'shipped-prebuilt' but it is absent from\n` +
          `    VENDORED_PACKAGES, so its shipped bytes are never read. Either add a\n` +
          `    VENDORED_PACKAGES entry describing where it ships, or correct the\n` +
          `    classification.`,
      );
    }
  }

  for (const name of [...effective.keys()].sort()) {
    if (!vendored.has(name)) continue;
    const entry = policy[name];
    // A missing policy entry is already reported by checkOverridePolicy;
    // don't double-report it here.
    if (!entry) continue;
    if (entry.classification !== 'shipped-prebuilt') {
      problems.push(
        `override '${name}' is classified '${entry.classification}', but '${name}' ships\n` +
          `    vendored inside a prebuilt asset (it is listed in VENDORED_PACKAGES).\n` +
          `    It must be classified 'shipped-prebuilt' so readers know the pin does not\n` +
          `    control what ships.`,
      );
    }
  }

  return problems;
}

/**
 * Part B: an override for a vendored package must equal the vendored version.
 *
 * Absent is a pass -- that is the desired steady state, because npm then
 * resolves the package from the vendoring package's own declaration.
 *
 * Exported for unit testing.
 *
 * @param {Map<string, Set<string>>} effective
 * @param {string} packageName
 * @param {string} shippedVersion
 * @returns {string | null} null on pass, message on failure
 */
export function checkOverrideAgainstShipped(effective, packageName, shippedVersion) {
  const values = effective.get(packageName);
  if (!values || values.size === 0) return null;
  const mismatched = [...values].filter((value) => value !== shippedVersion);
  if (mismatched.length === 0) return null;
  return (
    `override '${packageName}' is pinned to ${mismatched.map((v) => `'${v}'`).join(', ')}, ` +
    `but the version that actually ships is ${shippedVersion}.\n` +
    `    This package is vendored inside a prebuilt asset, so an override changes only\n` +
    `    node_modules/ -- it does NOT change a single shipped byte. Bumping it would\n` +
    `    silence Dependabot alerts without remediating anything, and can additionally\n` +
    `    HIDE advisories that affect the older shipped copy (issue #514).\n` +
    `    Fix: remove the override entirely and let npm resolve it from the vendoring\n` +
    `    package's own declaration. To actually change what ships, bump the vendoring\n` +
    `    package instead.`
  );
}

/**
 * Collects every distinct version matched by `patterns` across files under
 * `root` that contain `marker`.
 *
 * Exported for unit testing via the pure `extractVersionsFromText` helper.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {Set<string>}
 */
export function extractVersionsFromText(text, patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    // Patterns carry /g; reset lastIndex so repeated calls are deterministic.
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return found;
}

function* walkFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Scans a shipped asset tree for the vendored package's version.
 *
 * Two-stage by design: a cheap byte-level `marker` pre-filter identifies the
 * chunk, then `versionPatterns` extract the version from it. The marker is a
 * PACKAGE-IDENTITY assertion -- it answers "is this the DOMPurify chunk?" --
 * which is why it stays `DOMPurify` rather than something like `version="`.
 * A generic marker could match an unrelated chunk that happens to carry a
 * version literal and silently report the wrong package's version.
 *
 * Exported for unit testing.
 *
 * @param {string} root
 * @param {{marker: string, versionPatterns: RegExp[]}} spec
 * @returns {{versions: Set<string>, markerFiles: string[]}}
 */
export function scanShippedTree(root, spec) {
  const markerBuffer = Buffer.from(spec.marker, 'utf8');
  const versions = new Set();
  const markerFiles = [];
  for (const file of walkFiles(root)) {
    if (!file.endsWith('.js')) continue;
    // Buffer.includes avoids decoding ~15-23 MB of JS to UTF-8 strings just to
    // find the handful of chunks that mention the marker.
    const buffer = readFileSync(file);
    if (!buffer.includes(markerBuffer)) continue;
    markerFiles.push(relative(root, file).split(sep).join('/'));
    for (const version of extractVersionsFromText(buffer.toString('utf8'), spec.versionPatterns)) {
      versions.add(version);
    }
  }
  return { versions, markerFiles };
}

/**
 * Asserts the configured asset input is still wired up in angular.json as a
 * FULL copy of the tree.
 *
 * Matches the asset *entry*, not a bare `input` string anywhere in the file,
 * and rejects a narrowed glob: changing `**\/*` to `*.css` would still copy
 * "the tree" by path while no longer shipping the JavaScript this gate reads
 * a version out of.
 *
 * Only entries inside an `assets` array are considered. Collecting every
 * object that merely has an `input` key would risk a false match against an
 * unrelated builder option, which could mask removal of the real `assets`
 * mapping. Scoping to `assets` is tighter than requiring an `output` field,
 * because Angular treats `output` as optional on an asset entry.
 *
 * @param {unknown} angularJson
 * @param {string} assetInput
 * @returns {string | null}
 */
export function checkAssetMapping(angularJson, assetInput) {
  /** @type {{input: string, glob: unknown}[]} */
  const entries = [];
  const collectFromAssets = (assets) => {
    if (!Array.isArray(assets)) return;
    for (const item of assets) {
      // Angular also permits a bare string asset ("src/favicon.ico"); those
      // carry no `input`, so they cannot match and are skipped.
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record = /** @type {Record<string, unknown>} */ (item);
        if (typeof record['input'] === 'string') {
          entries.push({ input: record['input'], glob: record['glob'] });
        }
      }
    }
  };
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      const record = /** @type {Record<string, unknown>} */ (node);
      if (Object.prototype.hasOwnProperty.call(record, 'assets')) {
        collectFromAssets(record['assets']);
      }
      for (const value of Object.values(record)) visit(value);
    }
  };
  visit(angularJson);

  const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  const matches = entries.filter((entry) => normalize(entry.input) === assetInput);

  if (matches.length === 0) {
    const found = entries.map((entry) => normalize(entry.input));
    return (
      `angular.json no longer copies '${assetInput}' as a static asset.\n` +
      `    Asset inputs found: ${found.length ? found.join(', ') : '(none)'}\n` +
      `    This gate reads the shipped version out of that tree, so the mapping change\n` +
      `    must be reflected in VENDORED_PACKAGES (scripts/check-dependency-overrides.mjs).`
    );
  }

  // A glob is optional in Angular's schema, but when present it must copy the
  // whole tree for the shipped-bytes scan below to be meaningful.
  const fullCopy = matches.some((entry) => entry.glob === undefined || entry.glob === '**/*');
  if (!fullCopy) {
    const globs = matches.map((entry) => JSON.stringify(entry.glob)).join(', ');
    return (
      `angular.json copies '${assetInput}' with a narrowed glob (${globs}), not '**/*'.\n` +
      `    This gate reads the vendored version out of the JavaScript in that tree, so a\n` +
      `    partial copy would make the reported version unrepresentative of what ships.`
    );
  }

  return null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function main() {
  const problems = [];
  const notes = [];

  if (!existsSync('package.json') || !existsSync('angular.json')) {
    console.error(
      'check-dependency-overrides: must run from the repository root (package.json + angular.json not found).',
    );
    return 2;
  }

  const pkg = readJson('package.json');
  const angularJson = readJson('angular.json');
  const effective = normalizeOverrides(pkg.overrides ?? {});

  // ---- Part A: classify + justify every override -------------------------
  problems.push(...checkOverridePolicy(effective, OVERRIDE_POLICY));

  // ---- Cross-check the two registries against each other ------------------
  // Runs unconditionally: a classification that disagrees with the vendored
  // registry can otherwise slip between Part A and Part B in either direction.
  problems.push(
    ...checkPolicyVendoredConsistency(
      effective,
      OVERRIDE_POLICY,
      VENDORED_PACKAGES.map((spec) => spec.package),
    ),
  );

  // ---- Part B: verify what actually ships --------------------------------
  for (const spec of VENDORED_PACKAGES) {
    const label = `${spec.package} (vendored by ${spec.vendoredBy})`;

    const mappingProblem = checkAssetMapping(angularJson, spec.assetInput);
    if (mappingProblem) {
      problems.push(mappingProblem);
      continue;
    }

    if (!existsSync(spec.assetInput) || !statSync(spec.assetInput).isDirectory()) {
      problems.push(
        `${label}: shipped asset tree '${spec.assetInput}' not found. Run \`npm ci\` first.`,
      );
      continue;
    }

    const { versions, markerFiles } = scanShippedTree(spec.assetInput, spec);

    if (markerFiles.length === 0) {
      problems.push(
        `${label}: no file under '${spec.assetInput}' contains '${spec.marker}'.\n` +
          `    ${spec.vendoredBy} may have stopped vendoring ${spec.package}, or moved it out of\n` +
          `    the tree we copy. Re-verify by hand and update VENDORED_PACKAGES.`,
      );
      continue;
    }
    if (versions.size === 0) {
      problems.push(
        `${label}: found '${spec.marker}' in ${markerFiles.join(', ')} but could not read a\n` +
          `    version literal. The upstream build may have started stripping it. Re-verify by\n` +
          `    hand and update the versionPatterns in VENDORED_PACKAGES.`,
      );
      continue;
    }
    if (versions.size > 1) {
      problems.push(
        `${label}: ambiguous shipped version -- found ${[...versions].sort().join(', ')} across\n` +
          `    ${markerFiles.join(', ')}. A human must determine which one ships.`,
      );
      continue;
    }

    const shippedVersion = [...versions][0];

    // Corroborate against the vendoring package's unminified copy. A missing
    // source is a FAILURE, not a skip: the header advertises this gate as
    // fail-closed, and silently dropping a corroboration source is exactly
    // the "assumption quietly goes stale" mode it exists to prevent.
    if (!existsSync(spec.esmSource)) {
      problems.push(
        `${label}: corroborating source '${spec.esmSource}' is missing, so the shipped\n` +
          `    version ${shippedVersion} cannot be cross-checked. If ${spec.vendoredBy} moved it,\n` +
          `    update esmSource in VENDORED_PACKAGES.`,
      );
    } else {
      const esmMatch = readFileSync(spec.esmSource, 'utf8').match(spec.esmPattern);
      if (!esmMatch) {
        problems.push(
          `${label}: could not read a version banner from '${spec.esmSource}' to corroborate\n` +
            `    the shipped version ${shippedVersion}.`,
        );
      } else if (esmMatch[1] !== shippedVersion) {
        problems.push(
          `${label}: shipped tree reports ${shippedVersion} but the unminified source at\n` +
            `    '${spec.esmSource}' reports ${esmMatch[1]}. These must agree.`,
        );
      }
    }

    // Corroborate against the vendoring package's declared dependency. Also
    // fail-closed: a missing manifest, or one that no longer declares the
    // package, breaks the "declared is a faithful proxy for vendored"
    // assumption that VENDORED_PACKAGES rests on.
    if (!existsSync(spec.declaringManifest)) {
      problems.push(
        `${label}: '${spec.declaringManifest}' is missing, so the shipped version\n` +
          `    ${shippedVersion} cannot be corroborated against the declared dependency.\n` +
          `    Run \`npm ci\` first; if the path changed, update VENDORED_PACKAGES.`,
      );
      notes.push(
        `${spec.package}: shipped ${shippedVersion} (vendored by ${spec.vendoredBy}, chunk: ${markerFiles.join(', ')})`,
      );
    } else {
      const manifest = readJson(spec.declaringManifest);
      const declared = manifest.dependencies?.[spec.package];
      if (!declared) {
        problems.push(
          `${label}: ${spec.vendoredBy}@${manifest.version} no longer declares a '${spec.package}'\n` +
            `    dependency, so the declared version can no longer corroborate the vendored one.\n` +
            `    Re-verify by hand and update VENDORED_PACKAGES.`,
        );
      } else if (declared !== shippedVersion) {
        problems.push(
          `${label}: shipped tree reports ${shippedVersion} but ${spec.vendoredBy}@${manifest.version}\n` +
            `    declares '${spec.package}': '${declared}'. The declared dependency is no longer a\n` +
            `    faithful proxy for what is vendored -- re-verify by hand.`,
        );
      }
      notes.push(
        `${spec.package}: shipped ${shippedVersion} (vendored by ${spec.vendoredBy}@${manifest.version}, ` +
          `chunk: ${markerFiles.join(', ')})`,
      );
    }

    const overrideProblem = checkOverrideAgainstShipped(effective, spec.package, shippedVersion);
    if (overrideProblem) problems.push(overrideProblem);
  }

  for (const note of notes) console.log(`check-dependency-overrides: ${note}`);

  if (problems.length > 0) {
    console.error('');
    console.error('check-dependency-overrides: FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    console.error('  See docs/supply-chain.md for the policy behind this gate.');
    return 1;
  }

  console.log(
    `check-dependency-overrides: OK (${effective.size} override(s) classified, ` +
      `${VENDORED_PACKAGES.length} vendored package(s) verified)`,
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
