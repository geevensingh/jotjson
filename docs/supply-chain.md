# Dependency supply chain

How JotJSON reasons about third-party code that reaches users, and the
policy governing `overrides` in `package.json`.

The organizing question is:

> **Does this pin control what actually ships?**

For most dependencies the answer is trivially yes - they flow through the
Angular build graph, so the installed version is the shipped version. For
code that ships **vendored inside a prebuilt asset**, the answer is no, and
a version pin becomes a claim about `node_modules/` that says nothing about
the artifact users download.

The gate `scripts/check-dependency-overrides.mjs` (wired into `npm run lint`
as `lint:dependency-overrides`) enforces the policy below.

---

## Policy

### 1. Every root `overrides` entry must be classified and justified

Each entry in `package.json` -> `overrides` must have a matching entry in
`OVERRIDE_POLICY` in `scripts/check-dependency-overrides.mjs`, classified as
one of:

| Classification | Meaning |
| --- | --- |
| `dev-only` | Nothing it pins ever reaches a user. The pin only constrains build tooling. |
| `prod-graph` | Ships via the Angular build graph. The pin genuinely controls shipped bytes. |
| `shipped-prebuilt` | Ships vendored inside a prebuilt asset. The pin does **not** control shipped bytes. Must also appear in `VENDORED_PACKAGES`. |

**Every** entry -- regardless of classification -- must additionally name a
specific `consumer` and give a `rationale`. Both are enforced for all three
classifications: `prod-graph` and `shipped-prebuilt` are the more
security-relevant cases, so exempting them would put the loophole in exactly
the wrong place.

An override with no policy entry fails the gate. Naming a *specific*
consumer is the forcing function - the same idiom `knip.jsonc` uses for its
allowlists. If you cannot name the package that depends on it, the override
is probably unnecessary.

The two registries are also cross-checked against each other, in both
directions:

- A `shipped-prebuilt` entry absent from `VENDORED_PACKAGES` fails -- its
  shipped bytes would never be read, since Part B iterates
  `VENDORED_PACKAGES`.
- An override on a package that *is* in `VENDORED_PACKAGES` but classified as
  anything other than `shipped-prebuilt` fails. This one is subtle: Part A
  accepts the classification, and Part B's equality check passes whenever the
  pin happens to equal the shipped version -- so without the cross-check a
  materially false classification would pass both parts.

A vendored package with **no** override needs no policy entry. That absence
is the desired steady state.

### 2. Never use an override to change a reported version you do not control

If a package ships vendored inside a prebuilt asset, an `overrides` bump
changes only `node_modules/`. It will close Dependabot alerts while changing
zero shipped bytes. **This is strictly worse than leaving the alerts open**,
because it converts a visible signal into a silent one - and, as the
DOMPurify case below shows, it can additionally *hide* advisories that
affect the older shipped copy.

The correct remediation is always to **bump the vendoring package**.

### 3. Prefer removing the override to pinning it

Once an override is removed, npm resolves the package from the vendoring
package's own declaration, so the reported version tracks the vendored one
automatically. Pinning the override to match the vendored version achieves
the same reported result but creates a standing obligation to hand-sync on
every upgrade. Let the resolver maintain the invariant.

---

## Current overrides audit

As of 2026-08-31.

| Package | Override | Installed | Scope | Consumer | Pin controls shipped bytes? |
| --- | --- | --- | --- | --- | --- |
| `@babel/plugin-transform-modules-systemjs` | `^7.29.4` | 7.29.4 | dev | `@babel/preset-env` | N/A - never ships |
| `fast-uri` | `^3.1.2` | 3.1.2 | dev | `ajv` | N/A - never ships |
| `hono` | `^4.12.16` | 4.12.23 | dev | `@hono/node-server`, `@modelcontextprotocol/sdk` | N/A - never ships |

All three are dev-only, so their pins are honest: nothing they constrain
reaches a user. `dompurify` was a fourth entry until issue #514; see below.

### Note on Dependabot and overrides

A common belief is that overridden packages are invisible to Dependabot.
That is **false** - Dependabot opens version-update PRs for `fast-uri` and
`hono` today. The real distinction is pin *shape*:

- **Range pins** (`^3.1.2`) - Dependabot updates the lockfile within the
  range freely.
- **Exact pins** (`3.4.1`) - Dependabot will not rewrite them, so the
  package silently stops receiving version updates.

Prefer range pins unless there is a specific reason to freeze an exact
version.

---

## Case study: DOMPurify vendored inside Monaco (issue #514)

### What was wrong

`package.json` carried `"overrides": { "dompurify": "3.4.1" }`. But
`angular.json` copies Monaco's prebuilt distribution wholesale:

```json
{ "glob": "**/*", "input": "node_modules/monaco-editor/min/vs", "output": "vs" }
```

and Monaco **vendors its own DOMPurify inside that bundle**. The evidence:

- `min/vs/editor.api-CalNCsUg.js` (monaco-editor@0.55.1) carries
  `/*! @license DOMPurify 3.2.7 ... */` and a `version="3.2.7"` literal.
- `monaco-editor@0.55.1` declares `dompurify: "3.2.7"`.
- There are **zero** bare-specifier imports of `dompurify`
  (`from 'dompurify'` / `require('dompurify')`) anywhere in the
  monaco-editor package. The npm copy was unreachable from shipped code.
- Every JotJSON import of `monaco-editor` is type-only and erased at compile
  time.
- `monaco-editor` is the only package in the tree that depends on
  `dompurify`.

So the DOMPurify reaching users was **3.2.7**, while the pin claimed 3.4.1.

### The pin was suppressing true findings

The pin was not merely decorative. Eight advisories cover 3.2.7 but **not**
3.4.1 (all with ranges below `3.4.0`):

`GHSA-h7mw-gpvr-xq4m`, `GHSA-crv5-9vww-q3g8`, `GHSA-v9jr-rg53-9pgp`,
`GHSA-39q2-94rc-95cp`, `GHSA-h8r8-wccr-v5f2`, `GHSA-cjmm-f4jc-qw8r`,
`GHSA-cj63-jhhr-wcxv`, `GHSA-v2wj-7wpq-c8vv`

The shipped 3.2.7 was affected by **18** advisories; Dependabot reported
**10**. Removing the override reopens the other eight, which is the correct
count for what ships.

### The fix

The override was removed, not bumped. npm now resolves the edge from
Monaco's own declaration:

```
$ npm ls dompurify --all
jotjson@1.4.0
`-- monaco-editor@0.55.1
    `-- dompurify@3.2.7
```

The reported version now equals the vendored version, so Dependabot
describes the artifact users actually download.

### How to re-verify by hand

```powershell
# What the shipped bundle contains (authoritative):
Get-ChildItem -Recurse node_modules/monaco-editor/min/vs -Filter *.js |
  Where-Object { (Get-Content $_.FullName -Raw) -match 'DOMPurify' } |
  ForEach-Object {
    [regex]::Matches((Get-Content $_.FullName -Raw), '\bversion\s*=\s*"([\d.]+)"') |
      ForEach-Object { "$($_.Groups[1].Value)" }
  }

# Corroborating sources:
Select-String '@license DOMPurify' node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js
node -p "require('./node_modules/monaco-editor/package.json').dependencies.dompurify"
```

Note that Monaco's minifier **stripped the `@license` banner as of 0.56.0**,
but a `version="x.y.z"` literal survives in both 0.55.1 and 0.56.0. The gate
reads the literal from the shipped tree and cross-checks it against the ESM
banner and the declared dependency.

---

## Reachability assessment (DOMPurify in JotJSON)

Establishes whether the advisories affecting the shipped DOMPurify are
actually exploitable here, so remediation urgency is a judgement about
JotJSON rather than about a version number.

**Conclusion: none of the 18 advisories affecting the shipped 3.2.7 appear
reachable through Monaco's usage in JotJSON.** Every one requires a
DOMPurify configuration option, a persistent-config API, an allowlist-
mutating hook, or an application-side re-parse that Monaco does not use.
The Monaco bump remains worthwhile as defense in depth, but is **not
urgent**.

### How Monaco calls DOMPurify

`esm/vs/base/browser/domSanitize.js` is the **sole** entry point -
`markdownRenderer.js` routes through it and makes no direct
`purify.sanitize` call. Verified identical in 0.55.1 and 0.56.0:

| Aspect | Monaco's usage |
| --- | --- |
| Config delivery | Fresh object spread **per call**; `setConfig()` / `clearConfig()` never called |
| Tag policy | `ALLOWED_TAGS` explicit allowlist (no `iframe`, `noscript`, `xmp`, `noembed`, `noframes`) |
| Attribute policy | `ALLOWED_ATTR` explicit allowlist |
| Protocols | `ALLOW_UNKNOWN_PROTOCOLS: true`, with `href`/`src` validated in an `afterSanitizeAttributes` hook |
| Hooks | Two; both **read** `data.allowedTags` - neither mutates it. `removeAllHooks()` in a `finally` |
| Output | `RETURN_TRUSTED_TYPE` or `RETURN_DOM_FRAGMENT` - never a re-parsed string |
| Never used | `IN_PLACE`, `SAFE_FOR_TEMPLATES`, `ADD_TAGS`, `ADD_ATTR`, `USE_PROFILES`, `CUSTOM_ELEMENT_HANDLING`, `FORBID_TAGS`, `RETURN_DOM` |

### Table A - content paths

Does user-controlled document content reach `sanitize()` as markup?

| Path | User-controlled source | Escaping | Markup reaches `sanitize()`? |
| --- | --- | --- | --- |
| `editor/contrib/links` hover | URL text in the document | `appendLink` escapes **delimiters only** (`]`, `)`, `"`) - not `<`, `>`, or backticks. Built as `new MarkdownString('', true)`, i.e. `isTrusted` | **Yes** |
| `editor/contrib/unicodeHighlighter` hover | Ambiguous/invisible chars in the document | `appendText` (full `escapeMarkdownSyntaxTokens`) + `appendMarkdown` for fixed copy | Escaped |
| JSON language-service hover | Schema descriptions | N/A - no schema is configured, so there is no hover content | No |
| Suggest widget documentation | Word-based suggestions | Word-based suggestions carry no documentation | No |

So content **does** reach the markdown -> sanitize pipeline via link hovers,
with only delimiter escaping. Monaco's own source carries CodeQL
suppressions reading *"The Markdown is fully sanitized after being
rendered"* - upstream's position is that DOMPurify **is** the sanitizer of
record on this path. It is therefore a genuine last line of defense, not a
redundant one.

Note that `modeConfiguration.hovers` is left at its default (enabled):
`json-editor.component.ts` calls `setDiagnosticsOptions` but never
`setModeConfiguration`.

### Table B - API and configuration preconditions

Content escaping alone cannot dismiss these; each turns on an API or option.

| GHSA | Patched | Precondition | Monaco? | Reachable |
| --- | --- | --- | --- | --- |
| `GHSA-55q2-fjhq-7xh7` | 3.4.13 | `IN_PLACE` + element-removing hook | Never uses `IN_PLACE` | No |
| `GHSA-c2j3-45gr-mqc4` | 3.4.12 | `CUSTOM_ELEMENT_HANDLING.tagNameCheck` | Never sets it | No |
| `GHSA-cmwh-pvxp-8882` | 3.4.11 | `setConfig()` bypassing the clone-guard | Passes config per call | No |
| `GHSA-vxr8-fq34-vvx9` | 3.4.9 | `clearConfig()` + reuse across trust boundaries | Never calls `clearConfig()` | No |
| `GHSA-gvmj-g25r-r7wr` | 3.4.8 | `SAFE_FOR_TEMPLATES` | Never sets it | No |
| `GHSA-rp9w-3fw7-7cwq` | 3.4.7 | `IN_PLACE` + shadow root | Never uses `IN_PLACE` | No |
| `GHSA-76mc-f452-cxcm` | 3.4.7 | Hook **mutating** `data.allowedTags`/`allowedAttributes` | Hooks read only; explicit allowlists supplied | No |
| `GHSA-x4vx-rjvf-j5p4` | (none) | `IN_PLACE` + attacker-supplied DOM | Never uses `IN_PLACE` | No |
| `GHSA-hpcv-96wg-7vj8` | 3.4.6 | Cross-realm `IN_PLACE` | Never uses `IN_PLACE` | No |
| `GHSA-r47g-fvhr-h676` | 3.4.6 | `IN_PLACE` + clobbered root | Never uses `IN_PLACE` | No |
| `GHSA-h7mw-gpvr-xq4m` | 3.4.0 | Function-form `ADD_TAGS` + `FORBID_TAGS` | Uses neither | No |
| `GHSA-crv5-9vww-q3g8` | 3.4.0 | `SAFE_FOR_TEMPLATES` + `RETURN_DOM` | Uses neither | No |
| `GHSA-v9jr-rg53-9pgp` | 3.4.0 | `CUSTOM_ELEMENT_HANDLING` fallback | Never sets it | No |
| `GHSA-39q2-94rc-95cp` | 3.3.4 | Function-form `ADD_TAGS` | Never sets it | No |
| `GHSA-h8r8-wccr-v5f2` | 3.3.2 | App re-parses sanitized output inside a rawtext wrapper | Inserts DOM fragment / TrustedHTML; never re-parses | No |
| `GHSA-v2wj-7wpq-c8vv` | 3.3.2 | Output placed in `noscript`/`xmp`/`noembed`/`noframes`/`iframe` | All five absent from `ALLOWED_TAGS` | No |
| `GHSA-cjmm-f4jc-qw8r` | 3.3.2 | `ADD_ATTR` predicate | Never sets it | No |
| `GHSA-cj63-jhhr-wcxv` | 3.3.2 | `USE_PROFILES` prototype pollution | Never sets it | No |

### Caveats

This assessment describes Monaco's usage **as of 0.55.1 / 0.56.0**. It is
not a guarantee:

- Upstream can change `domSanitize.js` in any release without notice, so the
  conclusion must be re-derived when Monaco is bumped.
- It covers Monaco's DOMPurify usage, not a proof that no other shipped code
  calls `sanitize()` differently. `domSanitize.js` is the only importer
  today.
- "Not reachable" is not "not worth fixing". Running a sanitizer with 18
  known bypasses relies on preconditions staying false, which is a fragile
  property to depend on.

---

## Preferred end-state

This gate is a **compensating control, not the destination.**

Monaco is deliberately loaded outside the Angular build graph
(`monaco-loader.ts` bootstraps the AMD loader against `/vs` at runtime) to
keep it out of the initial bundle budget. The cost is that everything inside
`/vs` - roughly 15 MB of prebuilt JavaScript, including a full vendored copy
of DOMPurify - is invisible to every dependency-scanning tool we run. No
SCA tool, `npm audit` run, or Dependabot scan sees it. The only reason we
know which DOMPurify ships is that this gate greps the bytes.

Structurally better end-states, roughly in order of preference:

1. **Bundle Monaco through the Angular build** so its dependencies become
   real graph edges that tooling can see. The tradeoff is the initial-bundle
   budget that motivated the current arrangement; a lazy-loaded chunk may be
   able to satisfy both.
2. **Maintain an explicit inventory (SBOM) of shipped third-party bundles**,
   generated at build time and diffed in CI. This generalizes the gate from
   one hand-configured package to everything inside `/vs`.
3. **Pin the copied assets by integrity hash** so at least the bytes are
   pinned even if their contents stay opaque.

Until one of those lands, treat `scripts/check-dependency-overrides.mjs` as
the inventory control for `/vs`, and remember that it only covers packages
explicitly listed in `VENDORED_PACKAGES`.

---

## Related

- Issue #514 - the DOMPurify override audit that produced this document.
- `scripts/check-dependency-overrides.mjs` - the enforcing gate.
- `DESIGN_SPEC.md` -> Security - the normative rule.
- `AGENTS.md` Sections 6 and 7 - contributor and agent guidance.
