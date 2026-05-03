# Agent Instructions - JotJSON

These are the default instructions for any AI coding agent (Copilot CLI, Copilot
coding agent, Cursor, Claude Code, etc.) working in this repository. Follow them
unless a task explicitly overrides a specific rule.

## 1. Source of Truth

- **`DESIGN_SPEC.md` is the authoritative product & architecture spec.** Read
  the relevant sections before making non-trivial changes.
- **Never silently deviate from the spec** (entities, routes, SKUs, limits,
  defaults). If a request contradicts the spec, or you believe a deviation
  is warranted, give a detailed written explanation of why and ask for
  explicit permission before implementing.
- If a deviation is approved, update `DESIGN_SPEC.md` in the same PR as
  the code change.

## 2. Tech Stack (non-negotiable defaults)

- **Frontend:** Angular (latest LTS), standalone components, Angular Signals for
  state, Angular Material for UI, Angular Router with lazy-loaded features,
  MSAL Angular for auth, SCSS for styles.
- **Editor:** Monaco (lazy-loaded). JSON/JSONC parsing via `jsonc-parser` - do
  **not** use native `JSON.parse` for user input.
- **Backend:** Azure Functions in **TypeScript (Node)**. No other languages.
- **Data:** Azure Cosmos DB (NoSQL, serverless). Respect container partition
  keys defined in the spec.
- **IDs:** UUID for internal PKs, NanoID (6 chars) for public slugs.
- **IaC:** Bicep under `/infra`.
- **Hosting:** Azure Static Web Apps with managed Functions.

Do not introduce new frameworks, languages, ORMs, state libraries, CSS
frameworks, or cloud services without explicit approval.

## 3. Repository Layout

Follow the Angular layout in `DESIGN_SPEC.md` -> *Project Structure*:

```
src/app/{core,shared,features}/...
infra/                 # Bicep
api/                   # Azure Functions (TypeScript)
.github/workflows/     # CI/CD
```

Place new code in the correct bucket:
- Singleton services / guards / interceptors -> `core/`
- Reusable UI / pipes / directives -> `shared/`
- Page-level features -> `features/<name>/`

## 4. Coding Conventions

### TypeScript (frontend + functions)
- `strict: true`, `noImplicitAny`. Never disable
  with `any` - use `unknown` + narrowing.
- Frontend `tsconfig.json` adds `noImplicitOverride`,
  `noPropertyAccessFromIndexSignature`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, plus Angular's `strictTemplates`.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are not yet
  on. Treat them as aspirational; do not introduce code that would break
  if they are turned on (e.g., always guard `arr[i]` for possible
  `undefined`).
- Production code must have **zero** `as unknown as ...` casts. If you
  hit a structural mismatch, change the function signature or write a
  narrow adapter object instead. Test files (`*.spec.ts`, `*.test.ts`)
  and test-helper modules under `src/testing/` or named `*.testing.ts`
  may use `as unknown as X` for partial framework stubs (`HttpRequest`,
  `Router`, `SwUpdate`, `MatSnackBarRef`, etc.) -- prefer
  `jasmine.SpyObj<T>` or `Partial<T>` intermediaries when feasible.
- Production code must have **zero** `as any`. The single test-file
  occurrence is grandfathered; do not add more.
- Test-only seams on production classes use the `__<verb>ForTesting`
  prefix (e.g., `__setJwksClientForTesting` in `api/src/shared/auth.ts`).
  Production callers must never reference these.
- Prefer `type` for unions/aliases, `interface` for object contracts that may be
  extended.
- No default exports in app code (except Angular-required cases).
- Async code uses `async/await`, not raw Promise chains.
- Never swallow errors. Log + rethrow or surface to the user via toast.

### Angular
- **Standalone components** only; no `NgModule`s for new code.
- Use **Signals** for component state; RxJS only at I/O boundaries (HTTP,
  routing, events).
- `computed()` for derived state; `effect()` only for syncing a signal to
  an external system (e.g., `localStorage`, `document.title`). Never use
  `effect()` for state derivation.
- Every `.subscribe(...)` in a component or non-singleton service must
  be paired with `takeUntilDestroyed()` (preferred) or an explicit
  `Subscription` cleanup in `ngOnDestroy`. Singleton (root-provided)
  services may subscribe without cleanup since they live for the app
  lifetime, but flag this in a code comment.
- Use `inject()` over constructor DI for new code.
- Components: `OnPush` change detection by default.
- Template logic stays trivial - push branching into the component or a pipe.
- Styles are component-scoped SCSS. Global tokens live in `src/styles/`.
- Theming uses the `TreeHighlightColors` / theme tokens from the spec - do not
  hardcode colors in components.
- When overriding Material component tokens in component SCSS, use the
  Material 21 `--mat-<component>-*` token names (e.g.,
  `--mat-slide-toggle-track-width`). The legacy `--mdc-<component>-*`
  names are silently no-ops on Material 21. The slide-toggle and
  button-toggle overrides in
  `src/app/features/profile/profile.component.scss` are reference
  examples.
- MatMenu use must go through `JJ_MENU_IMPORTS` (from
  `src/app/shared/material/jj-menu-imports.ts`), not `MatMenuModule`
  directly. The barrel bundles `MatMenuModule` with
  `CloseMatMenuOnWindowBlurDirective` so every `MatMenuTrigger`
  auto-dismisses on `window.blur`; direct `MatMenuModule` imports skip
  that behavior.
- Logging and telemetry: see §4 Telemetry below for the unified rules
  (frontend `LoggerService`, backend `trackEvent`, message-id catalog,
  privacy guardrails). The TL;DR for Angular code is "use
  `LoggerService` not `console.*` in production."

### Internationalization (i18n)
- v1 ships in English only, but **all user-facing strings must be extractable**
  per `DESIGN_SPEC.md` §Internationalization.
- Template text, attribute values (including `matTooltip`, `aria-label`,
  `title`, `placeholder`), and visible labels use Angular `i18n` attributes
  with a stable ID, e.g., `i18n="@@toolbar.paste.tooltip"`. Non-text attributes
  use `i18n-<attrname>="@@id"`.
- TS/Runtime strings (toast messages, logs that are visible to users, aria
  labels bound via expressions) use `$localize` tagged template literals with
  a stable ID, e.g., ``$localize`:@@upload.tooLarge:File too large - max 5 MB` ``.
- Stable ID convention: `<area>.<element>.<purpose>` in camelCase / dot
  segments (e.g., `@@tree.search.placeholder`, `@@home.empty`).
- **Renaming visible text:** when changing the user-visible source
  string for an existing UI element, keep the existing i18n message
  ID stable; only the source text changes. This avoids invalidating
  prior translations and history. Re-run `npm run extract-i18n` so
  `messages.xlf` is regenerated with the new source.
- **Pre-bootstrap exception:** strings rendered before Angular's
  bootstrap completes (e.g., the cold-boot splash inside `<app-root>`
  in `src/index.html`) sit outside the i18n pipeline by necessity -
  `$localize` and `i18n` attributes only resolve once Angular is up.
  These strings stay hardcoded in English. Keep the set as small as
  possible (currently just the splash label "Loading JotJSON...");
  any new pre-bootstrap text needs the same exception comment.
- Never use plain strings in templates or `console.warn`/`toast` calls when
  they are user-visible.
- Run `npm run extract-i18n` to refresh `src/locale/messages.xlf` when you add
  or change strings.

### Azure Functions
- One function per folder. Keep handlers thin; put logic in `src/lib/`.
- Validate all inputs with hand-written `assert<Shape>(value: unknown): Shape`
  guards (see `assertEnum` / `assertInt`, plus `assertBool` / `assertHex`
  for booleans and 6-digit hex colors, in `api/src/shared/preferences.ts`
  for the pattern). Throw a typed validation error and translate to
  `400 Bad Request` at the handler edge. (We do not use zod -- the
  hand-rolled approach keeps the deployed bundle small.)
- Return typed JSON responses with explicit status codes. Never leak stack
  traces. Status code conventions:
  - `200` read or update success, `201` create success.
  - `204 No Content` delete success - no body. Used by
    `DELETE /api/blobs/{id}` and `DELETE /api/history`.
  - `400` request-shape validation failed.
  - `401` missing or invalid auth (token expired, signature failed).
  - `403` authenticated but not allowed (e.g., not the blob owner).
  - `404` resource does not exist or caller cannot see it.
  - `409` idempotent-create conflict.
  - `429` rate / quota exceeded.
  - `500` server error - log full detail; respond with a generic
    message.
- Auth: validate Entra External ID-issued JWTs on every protected route.

### Telemetry

JotJSON has a robust manual telemetry stack on both sides (Angular
SPA + Azure Functions, both feeding the same Application Insights
resource). When you add a feature, instrument it. The defaults
below are calibrated against the unsampled / 100%-sampling reality
of both pipelines, so noise is the larger risk than blind spots.

**Default: yes.** New user-visible behavior, HTTP chokepoints,
perf-sensitive paths, and recoverable error paths should emit
telemetry. The judgment call is *what* to emit and *which sink* to
use, not *whether* to emit.

**Frontend pipeline** (`src/app/core/telemetry/`):

- Use `LoggerService` for everything; direct `console.*` calls are
  permitted only in `src/app/core/telemetry/` itself and `src/main.ts`
  (early-boot bootstrap errors). Test files (`*.spec.ts`, `*.test.ts`)
  may reference `console.*` for spies and expectations.
- Pick the right sink up front (migrating later breaks history):
  `logger.event(id, props?, measurements?)` -> `customEvents` for
  successful product-analytics signals; `logger.info/warn(id, props?)`
  -> `traces` for diagnostic / lifecycle / recoverable warnings;
  `logger.error(id, cause, props?)` -> `exceptions`.
- Register every new messageId in the frozen literal-union in
  `src/app/core/telemetry/telemetry-message-ids.ts` with a JSDoc
  block documenting **Severity**, **Fired by** (call site), **Props**,
  **Measurements** (for `event` tokens), and **Exception** (for
  `error` tokens). Banned: `as TelemetryMessageId` casts in
  production code -- `check-spec-patterns.mjs` enforces this.

**Backend pipeline** (`api/src/shared/telemetry.ts`):

- Use `trackEvent(name, properties?, measurements?)`. Properties land
  in `customDimensions`; numeric data in `customMeasurements`.
- The backend does **not** maintain a literal-union catalog yet (only
  four events live as of 2026-04-30). Raw string literals are
  acceptable below ~10 events; revisit when the count grows.
- Update the **Backend events** table in `docs/telemetry.md` whenever
  you add a new backend event.
- **Backend `trackEvent` has no sanitizer or redaction initializer.**
  Unlike the SPA pipeline (which strips query strings, redacts
  `Authorization`, and drops `?`-bearing envelopes via
  `TelemetryService`'s privacy initializer), the backend ships
  whatever you pass. **Never** pass raw exception messages,
  request/response bodies, JWT claims, auth headers, URLs, query
  strings, slugs, OIDs, or any user/session/request IDs. Sanitize at
  the call site or do not emit.

**When to instrument** (rubric):

- YES: success counters for major user actions (save / paste / upload
  / share / sign-in); auth, access-control, quota, and rate-limit
  chokepoints; perf events crossing a slow threshold; recoverable
  error paths with a closed-enum reason; product-analytics signals
  that drive a known question.
- NO: internal helpers and utilities; per-keystroke or per-row events
  (too high-cardinality / high-volume); semantically redundant events
  with no new question answered. Frontend + backend pairs are
  **allowed and often desirable** when they capture different
  lifecycle stages or different failure domains (e.g., `save.attempt`
  on the frontend vs. `quota.exceeded` on the backend -- these answer
  different questions and together form a funnel).

**Privacy guardrails** (cross-link to §6 Security & Privacy):

- Properties are closed-enum strings only (e.g., `'blob' | 'ruleSet'`,
  `'true' | 'false'`, `'create' | 'clone'`). Never free-form text.
- Numeric values use bucket dimensions via
  `src/app/core/telemetry/buckets.ts` (`bucketBytes`, `bucketCount`)
  plus raw measurement values; never raw bytes / counts as
  dimensions.
- Color values use coarse named buckets plus `isDefault`; never raw
  hex.
- **No per-user, per-session, per-request, per-document, or
  per-correlation identifiers** in `customDimensions` or
  `customMeasurements`. Build metadata (`appVersion`, `buildSha`) is
  the only carve-out from the closed-enum cardinality rule.
- Frontend already sets the authenticated-user context via Entra OID
  through `setAuthenticatedUserContext`. Do **not** copy OID, email,
  UPN, or display name into event props.
- Do **not** invent custom session / request / correlation IDs.
  Platform correlation already exists (W3C tracing,
  `enableCorsCorrelation`). Add a custom correlation ID only with
  explicit approval for a concrete debugging or incident need.

**Volume control:** every new event is one of:

- **One-shot** -- fires at most once per session / per worker
  lifetime (e.g., `app.boot`, `monaco.loaded`).
- **Thresholded** -- fires only when a measurement crosses a slow /
  large / failure threshold (e.g., `parse.slow`, `tree.expand.slow`).
- **Sampled** -- fires on a fraction of occurrences. Default is
  **unsampled**; if you sample, document the rate in the messageId
  JSDoc.
- **Bounded-frequency** -- the call site is naturally bounded by user
  action (one save click, one paste, one quota check). State the
  bound in the JSDoc.

**Test requirement:** every new event ships with at least one spec
asserting its emit shape (name, properties, measurements). The repo
pattern uses `__setTelemetryClientForTesting` /
`__resetTelemetryInitForTesting` (backend) and the
`TelemetryService` spy harness (frontend).

See `docs/telemetry.md` for KQL examples, sinks table, bucketing
helpers, the privacy initializer details, and the canonical Backend
Events catalog.

### Naming
- Files: `kebab-case.ts`. Angular: `thing.component.ts`, `thing.service.ts`,
  `thing.pipe.ts`, `thing.guard.ts`.
- Classes: `PascalCase`. Variables/functions: `camelCase`. Constants: `UPPER_SNAKE`.
- **Use descriptive names.** Variables, parameters, and functions must
  use whole-word, intention-revealing names - not single letters or
  ad-hoc abbreviations like `a`, `b`, `x`, `y`, `tmp`, `val`, `data2`.
  Prefer `accountId` over `aId`, `nextNode` over `n`, `timeoutMs` over
  `t`. **Prefer the full word over a shortened form**: write `index`
  not `idx`, `error` not `err`, `request` not `req`, `response` not
  `res`, `length` not `len`, `count` not `cnt`, `previous` not `prev`,
  `current` not `cur`, `temporary` not `tmp`, `value` not `val`. The
  only generally-accepted abbreviations are well-established
  three-or-more-letter terms (`url`, `id`, `db`, `api`, `http`,
  `json`, `lhs`/`rhs`, `min`/`max`). Single-letter names are only
  acceptable in these specific idiomatic cases:
  - **Numeric loop counters**: `i`, `j`, `k` in `for (let i = 0; ...)`
    or equivalent `while` counters.
  - **Sort comparators**: `[].sort((a, b) => ...)` -- canonical JS
    idiom; do not rename.
  - **Angular Router lazy-load callbacks**: `import('./x').then((m) =>
    m.Foo)` -- framework convention.
  - **Destructured domain components**: `const [y, m, d] =
    isoDate.split('-')` and similar where the letters map to a
    well-known mnemonic (year/month/day, x/y/z coordinates).
  - **Trivial one-liner identity-style lambdas**:
    `arr.map((p) => p.id)`, `arr.filter((b) => b.active)`. Acceptable
    when the lambda body is a single property access or comparison and
    the source array's element type is obvious from context. Anything
    more complex (multi-line body, multiple references to the param)
    must use a real word.
  Anywhere outside these exceptions - including persistent local
  variables, function parameters, generic type parameters that carry
  meaning, and non-trivial callback bodies - use a real word.
- Test files: co-located as `*.spec.ts`. **Exception:** the `api/`
  workspace currently uses `*.test.ts` (Jest convention). New api/
  test files should still use `*.test.ts` until the workspace is
  migrated. Do not mix conventions within a workspace.

### ASCII-only repository
- Tracked source files **must be ASCII** unless the codepoint is explicitly
  allowlisted in `scripts/check-ascii.mjs`. Use `-` for em/en-dash, `...` for
  ellipsis, `->` for right-arrow, `<=` / `!=` / `x` for math, `[x]` for check
  marks, etc. i18n-extractable strings go through Angular's i18n pipeline,
  not inline Unicode typography.
- CI runs `npm run check:ascii` on every push and PR. If you genuinely need a
  new non-ASCII codepoint (e.g., a UI glyph), add it to the `ALLOWED` set in
  `scripts/check-ascii.mjs` with an inline comment explaining why.

### Offline-first patterns

When a feature needs to keep working while the user is offline, follow
the pattern established by `RuleSetsService` (M6g-4) at
`src/app/core/api/rule-sets.service.ts`. This is the canonical example
for new offline-capable features.

Cached reads:
- Mirror the server snapshot to a user-scoped `localStorage` envelope:
  `jotjson.<feature>.cache.v1` storing `{ userId, ...payload }`.
- On hydrate, reject and `removeItem` if `userId` does not match the
  current `auth.user()?.id`. Cross-user cache leakage is a privacy bug,
  not just a UX wart.
- Clear the cache on sign-out (in the same effect that resets in-memory
  state).
- Single-doc reads (`get(id)`) should seed the cache so a cold-start
  offline editor can optimistically mutate without a prior list call.

Queued writes:
- Persist queued writes at `jotjson.<feature>.queue.v1`. Each item
  carries `userId`; filter mismatched entries on hydrate.
- Coalesce per-id: collapse multiple queued updates for the same id to
  the latest payload, but keep the **first** queued `baseVersion` so
  the eventual `If-Match` still matches the server's known version. A
  queued delete after queued updates for the same id supersedes them
  all.
- Status-0 / network failures during a live request fall back into the
  queue (treated as transient offline).
- The visible state (`ruleSets()`) is a `computed()` projection over
  `serverSnapshot + queue`, not a separately mutated signal. This
  keeps the UI consistent with what is actually persisted.

Drain:
- Subscribe to `fromEvent(window, 'online')` and to `auth.user()`
  changes; both trigger a serial drain.
- Drain policies: `412` -> emit a `conflict` event, refresh from
  server, recurse. Other `4xx` -> emit an `error` event, refresh,
  recurse. `5xx` / `0` -> requeue at head and stop. `404` on delete
  is idempotent success.
- Idempotency: guard re-entry with an `_inFlight` field so synchronous
  recursive `tryDrain()` calls are safe.

Service surface (UI-agnostic):
- Expose `pendingWriteIds(): Signal<ReadonlySet<string>>` and
  `pendingWriteCount(): Signal<number>` for badge / pill UX.
- Expose `events$: Observable<...>` (a `Subject`) for `conflict` /
  `error` notifications. **Do not** inject `MatSnackBar` into core/api
  services; the consuming component (rule editor, list page, etc.)
  owns the snackbar.

Telemetry stays counts-only (no IDs, names, or user content) per the
existing `LoggerService` conventions.

### Local-only dev-auth bypass

For local development, a tightly-guarded bypass lets you act as a fake
signed-in user without going through MSAL or Entra. **Never enable it
in any deployed environment.**

Frontend:
- Add a `devAuth` block to your gitignored `src/environments/environment.ts`
  (template in `environment.example.ts`). Set `enabled: true` and pick a
  `userId` matching `^[a-z0-9_-]{1,64}$` (e.g. `dev-user-1`).
- The toolbar Sign-in / Sign-out buttons toggle a `localStorage` flag
  (`jotjson.devAuth.signedIn`) instead of calling `loginRedirect` /
  `logoutRedirect`. `AuthService.acquireTokenSilent()` returns
  `dev:<userId>`, which the auth interceptor forwards as
  `X-Jotjson-Authorization: Bearer dev:<userId>`.
- If `enabled: true` but `userId` fails the regex, the dev mode is
  **disabled** (fail-closed) and a `auth.devMode.misconfigured` warning is
  logged via `LoggerService`.

Backend (`api/src/shared/auth.ts`):
- The bypass engages only when **all three** conditions hold:
  `JOTJSON_DEV_AUTH_BYPASS=true`, `WEBSITE_INSTANCE_ID` is unset, and
  `WEBSITE_HOSTNAME` is either unset or matches `localhost(:<port>)?`.
  `WEBSITE_INSTANCE_ID` is always set on Azure (App Service / Functions /
  Static Web Apps) and never set locally; `WEBSITE_HOSTNAME` is set on
  Azure to the external hostname (e.g. `<site>.azurewebsites.net`) but
  is also set by Azure Functions Core Tools 4.x to `localhost:7071`
  locally, so we only treat non-localhost values as an Azure indicator.
  Even a leaked `JOTJSON_DEV_AUTH_BYPASS=true` cannot enable the bypass
  on any Azure host.
- When engaged, `verifyAccessToken` accepts `dev:<userId>` and synthesizes
  a principal with full `oid`/`sub`/`name`/`preferred_username`/`email`
  claims. Any other token shape continues through normal Entra JWT
  validation, so real tokens are never silently accepted.
- A one-time `console.warn` is emitted on first dev-token use as a safety
  reminder.

Set `JOTJSON_DEV_AUTH_BYPASS=true` in `api/local.settings.json` (under
`Values`) for local Functions runs; do not commit this file.

## 5. Testing

- **Always add/update tests** for logic changes. No test = not done.
- Frontend: **Karma + Jasmine** (configured via `karma.conf.js` with a
  `ChromeHeadlessCI` launcher for GitHub Actions). Run with `npm test`
  locally and `npm run test:ci` in CI (adds `--code-coverage`). Co-locate
  specs as `*.spec.ts` alongside the unit under test.
- Functions: Jest with mocked Cosmos / Blob clients.
- Test names describe behavior: `it('returns 404 when blob slug is unknown')`.
- Run the full lint + test + build suite before declaring completion (see §7).

### Fast inner loop

For incremental work, prefer the fast inner loop over the full
Definition of Done cycle (§7) on every iteration:

- **`npm run verify:fast`** runs `lint` + `ng test` in one shot,
  **without** the production build or i18n extraction. Use this as
  the default check during iteration.
- For focused iteration, pass `--include` through to `ng test`:
  ```
  npm run verify:fast -- --include='**/extract-json-banner/**'
  ```
  Runs only specs matching the glob - seconds instead of a full
  ~1500-test suite.
- **Skip `npm run extract-i18n`** unless you added, removed, or
  renamed user-visible strings (`i18n=` attributes or `$localize`
  tagged templates). It does a full Angular build (~20s) and is
  wasted churn otherwise. When you do change strings, keep i18n
  message IDs stable per §4 Internationalization.
- **Skip `npm run build`** (and `build:prod`) during inner-loop
  iteration. `npm run lint` already catches the same type errors via
  `tsc --noEmit`. Run a build only when:
  - You are about to declare a task done (DoD §7 #3), OR
  - The change could affect bundle size, template-only errors, or
    production-only optimisations (e.g., new lazy-loaded route).

For sustained work on a single area, kick off long-lived watchers
in background terminals so each save checks incrementally:

```
npx tsc --noEmit -p tsconfig.app.json --watch
ng test --watch --browsers=ChromeHeadless --include='**/<focus>/**'
```

After the initial cold start, every save reports type errors and
re-runs affected tests in seconds. Stop the watchers before running
the full DoD cycle to avoid Karma port collisions.

## 6. Security & Privacy

- **Never** log or transmit clipboard contents, editor contents, or PII beyond
  what the feature requires.
- No secrets in source. Use SWA/Functions app settings + Key Vault references.
- Enforce the size/quota limits from the spec (1 MB saved blob, 5 MB upload,
  100-blob cap, etc.). Enforce on both client and server.
- Sanitize any user-provided strings rendered as HTML. Prefer Angular's default
  interpolation/binding over `innerHTML`.
- All API routes that mutate or read user data require a valid Entra External ID
  token except
  the explicitly-public blob read path.

## 7. Definition of Done

These checks run before declaring a task done, **not** on every save.
For inner-loop iteration use `npm run verify:fast` (see §5 "Fast inner
loop"); the steps below are the final sweep.

Before finishing a task:
1. `npm run lint:all` passes -- it is the canonical local gate that
   runs root lint + api workspace lint, mirroring what CI lints across
   both workspaces. (You can still run them individually: root
   `npm run lint` and `npm --prefix api run lint`.) Frontend lint is
   `tsc --noEmit -p tsconfig.app.json` + `check-ascii.mjs`,
   `check-spec-patterns.mjs`, `check-prod-patterns.mjs`, and
   `check-format.mjs` (the prettier annotation wrapper -
   `npm run format:check` is the equivalent for direct invocation).
   Formatting is enforced repo-wide, including `api/**`, from the
   root. The `api/` lint is `tsc --noEmit`. ESLint is not installed.

   Each gate also has its own per-script entry point so CI can run
   them as separate steps with inline annotations and a per-gate
   summary: `npm run lint:tsc`, `npm run lint:ascii`,
   `npm run lint:spec-patterns`, `npm run lint:prod-patterns`,
   `npm run lint:format`. **When CI fails, look at the failing
   step's name in the run page** - the gate that broke is named
   directly (e.g., "Lint - Prettier formatting"). The "Lint
   summary" rollup step at the end of the job restates which gate
   failed and the exact fix command. File-level (and where
   available, line-level) failures are surfaced as inline
   annotations on the PR Files Changed view.

   A husky pre-commit hook installed by `npm install`'s `prepare`
   script runs `prettier --write` on staged files at `git commit`
   time, so locally mis-formatted files are auto-fixed before the
   commit lands with no manual hook setup after a fresh clone. It only
   formats files matching the `lint-staged` glob in `package.json`, and
   `.prettierignore` exclusions (notably `*.md` and other
   hand-formatted files) are respected automatically. The hook does not
   run tsc, ASCII, or pattern checks; those still surface only in
   `npm run lint:all` and CI.
2. `npm test` passes (frontend and `api/`).
3. `npm run build` (or `ng build --configuration production`) succeeds.
4. `npm run check:ascii` passes (no new non-ASCII codepoints outside the
   allowlist in `scripts/check-ascii.mjs`).
5. `npm run format` to reformat changed files (or rely on editor
   format-on-save). `npm run format:check` is a read-only equivalent
   that runs as part of `npm run lint`.
6. Only run the suites that exist - do not introduce new toolchains to satisfy
   this checklist. If a suite isn't set up yet and the task is scaffolding,
   set it up per the spec.
7. No new TypeScript errors or console warnings introduced.
8. Spec is updated if behavior or architecture changed.
9. Telemetry decision recorded: explicitly decide whether the change
   warrants a telemetry event. If you add one, ensure the messageId
   is registered (frontend), the emit-shape spec is in place, and
   `docs/telemetry.md`'s Backend events table is updated for backend
   events. See §4 Telemetry.
10. **SemVer bump decision recorded.** Before committing, decide
    explicitly whether the change warrants a SemVer bump per
    `DESIGN_SPEC.md` -> Versioning -> SemVer bump rules. If yes, edit
    `package.json` in the same commit. If no, state "no bump" in the
    response (and ideally in the commit body) so the decision is on
    the record. The build counter + SHA already give per-deploy
    resolution, so most non-feature work is "no bump."

## 8. Git & PR Hygiene

- Small, focused commits with imperative subject lines (e.g.,
  `Add slug collision check to BlobService`).
- Stage files explicitly by path. **Never** run `git add -A`,
  `git add .`, or `git add --all`. This prevents committing unrelated
  edits, generated files, or session-state artifacts.
- **Never** run `git rebase` or `git pull --rebase`. When branches
  diverge, use `git pull --no-rebase` (merge), or stop and ask. The
  "do not rewrite or force-push" rule below already prohibits the
  destructive form; this rule prohibits the local form too.
- Never commit secrets, `.env`, `node_modules`, build output, or editor files
  beyond what `.gitignore` already covers.
- Do not rewrite or force-push shared branches.
- When a commit is authored with AI assistance, include:

  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

- When opening or triaging an issue, apply exactly one priority label:
  `priority:high`, `priority:medium`, or `priority:low`. These three
  labels are the only priority signal in the repo (we do not use a
  Project board field). Existing kind/area labels (e.g., `bug`,
  `accessibility`, `tech-debt`, `ux`) are orthogonal and still apply.

## 9. Scope Discipline

- Make surgical changes that fully address the request. Do not refactor
  unrelated code, rename files, or reformat untouched areas.
- If you find a tightly-coupled bug caused by the code you're changing, fix it.
  Otherwise, note it and move on.
- Prefer ecosystem tooling (`ng generate`, `npm init`, codemods) over manual
  file creation.

## 10. When In Doubt

- Re-read the relevant `DESIGN_SPEC.md` section.
- Ask a clarifying question rather than guessing on behavioral choices,
  defaults, limits, or scope. See §11 for the mandatory plan-and-approval
  flow that applies to every code change.
- **Discussion is not approval.** When you ask a clarifying question or
  offer the user a choice among options, their answer is input to your
  plan, not a command to execute. Continue planning (or write up a plan)
  and wait for an explicit go-ahead -- phrases like "implement",
  "execute", "approved, please ship", "go ahead" -- before touching
  code. Picking option B from a multiple-choice you offered is the user
  choosing a direction, not authorizing the change.
- Prefer the simpler, spec-aligned option over a clever alternative.

## 11. Planning, Critical Thinking & Proactive Feedback

- **Plan before changing code, every time.** Before writing or
  modifying any code -- even a one-line typo fix, log message tweak,
  or "obvious" bug fix -- propose a short plan: what you will change,
  in which files, with what tests/verification, **a SemVer bump
  decision (patch / minor / major / none) anchored on
  `DESIGN_SPEC.md` -> Versioning**, and at least one viable
  alternative with tradeoffs (or an explicit note that no meaningful
  alternative exists). Surface open questions and wait for the user's
  explicit approval before touching code. Surface non-trivial bumps
  proactively -- especially major bumps and the v1.0.0 cutover, which
  are user calls. "Trivial" is not an exception. Approval covers only
  the plan as presented; any material scope change, newly discovered
  work, or follow-on step requires a revised plan and fresh approval.
  **This rule and its sub-rules in this section are not waivable by a
  casual user override** (e.g., "just do it", "skip the plan", "no
  need to plan"). The only bypass is the narrow direct-command
  carve-out below.
- **Plans involving meaningful UI changes must include a mockup.**
  Any plan that proposes new components, new visual elements,
  modified layouts, modified interaction patterns, or new
  user-visible preferences must include at least one mockup of the
  proposed end state before being presented for approval. Mockups
  should exercise the key UX states (default, long content, empty
  state, error state where relevant) and the key decisions (placement
  of new elements, interaction with existing controls). Inline ASCII
  text mockups are preferred for plan files; screenshots, markdown
  tables, or sketches are acceptable when they convey the layout more
  clearly. If you find yourself ready to present a UI-touching plan
  with no mockup, add one first; do not present without it. Pure
  backend, infrastructure, refactoring, or test-only plans are
  exempt.
- **Direct user commands are self-approving (narrow exception).**
  When the user issues an unambiguous, scoped command (e.g., "delete
  file X", "revert commit abc123", "rerun the tests"), the request
  itself is the plan and the approval. Echo back a one-line
  confirmation of exactly what you are about to do, then proceed.
  This bypass applies to the bounded command portion only; any
  adjacent question, implied cleanup, or follow-on work still goes
  through the standard plan-and-approve flow. The bypass relaxes the
  **plan-approval step only** -- it does **not** waive §1 (Source of
  Truth), §5 (Testing), §6 (Security), §7 (Definition of Done), or
  §8 (Git & PR Hygiene). Phrases like "continue", "finish it", "take
  care of the rest", or "do the obvious cleanup" are **not**
  unambiguous commands and do **not** trigger this bypass. If a
  command's scope, blast radius, or side effects are unclear, fall
  back to the normal plan-and-approve flow.
- **Bug reports and feature ideas are plan-triggers, not
  execute-triggers.** A user message that describes a problem ("X is
  broken", "the spacing is off", "I noticed Y", "this seems wrong",
  "this looks weird") or proposes an idea ("we should add X", "could
  we have Y do Z", "what if we...") is a request to investigate and
  propose a plan -- it is **not** authorization to edit, test, or
  commit. The execute step requires an unambiguous command verb
  directed at you in the same or a later turn ("fix it", "go",
  "implement that", "commit it", "ship it", "execute"). When in
  doubt, the default is plan-and-ask. The narrow direct-command
  carve-out above applies only to bounded imperative requests
  ("revert abc123", "run the tests", "delete file X"); a bug report
  does not qualify even when the user's intent to eventually fix it
  is obvious. The user reporting a problem is delegating diagnosis
  and planning to you, not authorization.
- **Rubber-duck every plan before presenting it.** Once you have a
  candidate plan, run it through a rubber-duck / critic sub-agent
  for an independent critique (correctness, missed edge cases,
  simpler alternatives, scope creep) before presenting the plan to
  the user. If no rubber-duck sub-agent is available in the current
  runtime, perform an explicit self-critique against the same
  checklist and label it as such. **Surface any rubber-duck finding
  that materially changes risk, scope, test strategy, or recommended
  approach** -- do not silently absorb such findings. Adopt findings
  that prevent bugs or test failures; you may set aside findings
  that would significantly complicate the plan without clear
  benefit, but state when you have done so. This step applies to
  plans you author; it does **not** apply to direct-command echoes,
  which are not plans.
- **User unavailability is never authorization to proceed.** If the
  runtime reports the user as away, busy, or unresponsive, that does
  not let you act on a guess. Ask the question anyway and wait. Do
  not assume answers, do not build a plan on assumptions, do not
  proceed autonomously.
- **Use `ask_user` to ask the user; never "make a best guess on
  autopilot".** When you need user input on scope, behavior,
  defaults, limits, or design, use the runtime's `ask_user` tool
  (or its equivalent) -- do not phrase questions as plain prose
  the user might miss. When the set of plausible answers is
  discrete, pass them via the tool's `choices` array. This rule
  applies in **every** runtime mode -- interactive, autopilot,
  fleet, and background -- and regardless of whether the runtime
  reports the user as available, busy, or away. "Making a best
  guess on autopilot" is forbidden: an autonomous runtime is
  **not** authorization to guess. If the user is unavailable, ask
  anyway, then stop; do not start implementing. To stop cleanly,
  use the runtime's plan-approval / completion channel (e.g.,
  `exit_plan_mode` in plan mode, or a task-completion tool with
  an ambiguity summary outside it), not free-form prose.
- Treat user suggestions as proposals, not orders. Think critically
  about each one before acting.
- When the user proposes an approach, evaluate whether it is sound,
  complete, and consistent with the codebase, the spec, and prior
  decisions. If you spot a flaw, a missed case, a simpler alternative,
  a better-fitting pattern, or a risk the user may not have weighed,
  **say so before implementing**.
- Offer suggestions and alternatives proactively, not only when asked.
  Examples of things worth raising unprompted:
  - Edge cases or failure modes the proposal does not handle.
  - Cheaper or simpler approaches that achieve the same goal.
  - Conflicts with `DESIGN_SPEC.md`, `AGENTS.md`, or existing
    conventions.
  - Hidden costs (perf, accessibility, i18n extraction, telemetry,
    test surface, blast radius).
  - Naming, API shape, or signature improvements.
  - Scope concerns: things being included that should be split out,
    or things being omitted that should be folded in.
- Be direct and specific. Vague hedging ("might want to consider...")
  is less useful than a concrete recommendation with a reason. Say
  what you think the right call is, and why.
- Disagree when you have a reason to. Do not silently comply with a
  request that you believe is wrong, incomplete, or risky -- raise
  the concern, explain it, and let the user decide. After the user
  decides, follow their decision unless they ask you to push back
  again.
- Critical thinking applies to your own prior recommendations too.
  If new evidence (test output, file contents, a rubber-duck review,
  a user correction) suggests an earlier suggestion was wrong,
  acknowledge it explicitly and revise.
- **Parallelize plan execution.** Once a plan is approved, treat its
  steps as a dependency graph, not a list. Dispatch every step with
  no unmet dependencies to a parallel sub-agent -- including waves
  further down the graph (e.g., if step 1 unblocks steps 2-9, run
  steps 2-9 in parallel after step 1 finishes, not serially). Only
  respect true dependencies: file conflicts, read-after-write on
  shared state, or an earlier step's output feeding a later step.
  Each sub-agent is stateless, so include the relevant plan slice,
  repo conventions (`AGENTS.md`, `DESIGN_SPEC.md`), and the
  definition-of-done checks it must satisfy. After each wave
  completes, re-evaluate which steps are now unblocked and fan those
  out too. Use whatever parallel sub-agent mechanism the current
  runtime exposes (e.g., `/fleet` in Copilot CLI; the `Task` tool in
  Claude Code).
- **Parallelize independent validation checks.** After making
  changes, run the §7 Definition-of-Done checks (lint, test, build,
  plus their `api/` counterparts) in parallel by issuing them in the
  same response with distinct shell sessions, rather than serially.
  They read the working tree but do not write to it, so there is no
  contention. Use orchestrator-level parallelism (separate shell IDs
  in one response) rather than sub-agents -- the output is just
  pass/fail and the orchestrator has to read each result anyway, so
  spinning up a sub-agent per check is pure overhead. Caveats: do
  not run two `npm install`s in parallel against the same
  `node_modules` (mutates shared state); if a test flakes under CPU
  contention, re-run sequentially before treating it as a real
  failure.

