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
frameworks, or cloud services without explicit approval. Likewise, do
not work around npm peer-dependency installation errors with
`npm install --legacy-peer-deps` or `--force` without explicit user
approval (see §7).

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

### Server-platform safety (prerender)

The home (`/`) and 404 (`/404`) routes are statically prerendered by
`@angular/ssr` running in Node at build time (M7h). The build runs
component constructors, field initializers, and eagerly-fired effects
on the **server platform**, which has no `window`, no `localStorage` /
`sessionStorage`, no `navigator`, no `IntersectionObserver`, no
`document.addEventListener` semantics for `online` / `offline`, etc.
A throw at any of these call sites aborts the prerender and the home
route silently emits `index.csr.html` (the SPA shell) instead of a real
prerendered `index.html`.

Rules for code that reaches the prerender path:

- **Inject `PLATFORM_ID` and gate browser-API code** with
  `isPlatformBrowser(inject(PLATFORM_ID))`. Establish the browser flag
  as a `protected readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));`
  field initializer (injection context); never call `inject()` from
  inside `ngOnInit` or other lifecycle hooks. Reference examples:
  `src/app/core/loading-splash/loading-splash.service.ts`,
  `src/app/core/api/rule-sets.service.ts`,
  `src/app/features/home/home.component.ts`.
- **Effects in constructors fire during prerender.** Anything an
  `effect()` does on the first sync run hits the server platform.
  Gate browser-only side effects (`localStorage` writes,
  `seo.clearBlobTags()`, `MatSnackBar.open()`, audio/clipboard
  bindings) on `this.isBrowser` inside the effect body, or skip the
  effect entirely with an early return.
- **Heavy components** (Monaco, JsonTree, status bar) keep the
  ApplicationRef unstable forever and time out the prerender. Wrap
  them in `@if (isBrowser) { ... } @else { <server-skeleton/> }`. The
  `@else` block ships the SEO copy crawlers should see (`<h1>` brand,
  tagline, description); the real components mount after client
  bootstrap. Reference: `src/app/features/home/home.component.html`.
- **Server-only providers** live in `src/app/app.config.server.ts`.
  This config supplies MSAL no-op stubs (`MSAL_INSTANCE`,
  `MsalService`, `MsalBroadcastService`), skips
  `provideServiceWorker`, and replaces
  `provideAppInitializer(AuthService.initializeFromRedirect)` with a
  no-op. Do not modify the browser `app.config.ts` to "be safe on the
  server" - keep server-specific behavior in `app.config.server.ts`.
- **Splash discrimination.** Prerendered HTML files carry
  `<meta name="prerendered" content="true">` (injected by
  `scripts/postbuild-seo.mjs`). `LoadingSplashService` reads the marker
  at construction and pre-latches `firstNavComplete = true` so the
  Angular splash never paints over prerendered content. Shell-fallback
  boots (every other route) have no marker and follow the legacy
  splash lifecycle.
- **Verify in CI.** `npm run check:prerender` (run by the postbuild
  pipeline) asserts the dist layout, marker placement, OG defaults,
  noindex, and asset presence. Run it locally after touching any of
  `src/index.html`, `app.config*.ts`, `app.routes.server.ts`,
  `home.component.*`, `not-found.component.*`,
  `loading-splash.service.ts`, `staticwebapp.config.json`, or
  `scripts/postbuild-seo.mjs`.

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
  possible (currently a single splash label "Loading JotJSON..."
  shown for both `/` and `/s/:slug` cold boots; the more specific
  "Downloading JSON..." and "Rendering tree..." labels come from the
  Angular splash component once it mounts and go through `$localize`
  normally); any new pre-bootstrap text needs the same exception
  comment.
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
- **Custom response/request headers**: use the `X-Jotjson-*` prefix for
  all first-party headers we own end-to-end. Examples in production
  today: `X-Jotjson-Authorization` (request, carries the bearer token
  to dodge the SWA managed-Functions `Authorization`-header rewrite)
  and `X-Jotjson-Body-Length` (response, GET `/api/blobs/{idOrSlug}`
  uncompressed UTF-8 byte count, used to drive the determinate
  blob-fetch progress bar because Azure Front Door's gzip pass strips
  `Content-Length`). The prefix matches what AFD lets through
  unchanged and avoids collisions with any standard or third-party
  header names. New first-party headers should follow the same
  pattern.

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
  - Within `api/`, **integration tests** (real-Cosmos-backed; #63)
    use `*.integration.test.ts` and live under `api/integration/`,
    NOT under `api/src/`. This keeps integration helpers out of
    the production build (`api/tsconfig.json` includes `src/**/*.ts`)
    and out of production-pattern lint scope. Integration tests
    are CI-only by default; run locally via
    `npm --prefix api run test:integration` after setting
    `COSMOS_CI_*` env vars (see `docs/ci-cosmos.md`).

### ASCII-only repository
- Tracked source files **must be ASCII** unless the codepoint is explicitly
  allowlisted in `scripts/check-ascii.mjs`. Use `-` for em/en-dash, `...` for
  ellipsis, `->` for right-arrow, `<=` / `!=` / `x` for math, `[x]` for check
  marks, etc. i18n-extractable strings go through Angular's i18n pipeline,
  not inline Unicode typography.
- CI runs `npm run lint:ascii` on every push and PR. If you genuinely need a
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

### CI Insights (Mergify)

After each test job, CI uploads the suite's JUnit XML to Mergify CI Insights
via `mergifyio/gha-mergify-ci@v17`. Wired suites: **api unit**, **api
integration**, **web unit** (Karma), **e2e** (Playwright). Dashboards live
at `https://dashboard.mergify.com/ci-insights/jobs`. JUnit artifacts and
`dorny/test-reporter` PR check-runs are unchanged and remain the canonical
in-repo signal; Mergify is an additive cross-PR view for flake and
duration trends.

- **Auto-Retry and Quarantine are explicitly disabled** per §11's
  zero-tolerance for silent retries on `main`. The four test steps must
  **not** carry `continue-on-error: true` (which would let Mergify
  override the runner's success/failure conclusion). Only the
  `Mergify CI Upload (*)` steps themselves carry `continue-on-error: true`,
  so a Mergify outage or expired token doesn't fail CI.
- **Token visibility**: each upload is followed by a `Mergify CI Upload -
  failure notice (*)` step that writes a `::warning::` annotation and a
  `$GITHUB_STEP_SUMMARY` line when the upload fails. This surfaces
  token/permission breakage on the run page; otherwise a stale dashboard
  is the only signal.
- **Conditional firing**: uploads use `if: steps.<id>.outcome ==
  'success' || ... 'failure'` (not `if: success() || failure()`), so the
  upload runs only when the test step actually executed. This prevents
  an `npm ci` failure from triggering an upload of a non-existent JUnit
  file.
- **Rollback**: delete the four `Mergify CI Upload (*)` steps and the
  four `Mergify CI Upload - failure notice (*)` steps from
  `.github/workflows/ci.yml`, remove the four `id:` attributes from
  the test steps, and revoke the `MERGIFY_TOKEN` repository secret.
  JUnit artifact uploads and `dorny/test-reporter` are unaffected.

### Fast inner loop

For incremental work, prefer the fast inner loop over the full
Definition of Done cycle (§7) on every iteration:

- **`npm run verify:fast`** runs `lint` + `test:scripts` (Node-built-in
  unit tests for `scripts/*.mjs`) + `ng test` in one shot,
  **without** the production build or i18n extraction. Use this as
  the default check during iteration. **Smoke e2e** (`npm run test:e2e`)
  is intentionally NOT part of `verify:fast` - it builds a production
  bundle and starts a real browser, which takes much longer than the
  fast inner loop. Run e2e only when you've changed code under `e2e/`,
  or when you want to verify a flow before committing. CI runs e2e
  on every PR regardless. **API integration** tests
  (`npm --prefix api run test:integration`, #63) are also NOT part of
  `verify:fast` - they require a real Cosmos DB account (`COSMOS_CI_*`
  env vars) and are CI-only by default. Run locally only when you've
  changed code under `api/integration/` or `api/src/shared/blobs.ts`.
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

**Align local with CI before non-trivial work.** Run `npm ci` (root)
and `npm --prefix api ci` once at the start of a meaningful change
so local `node_modules` matches the lockfile CI installs from. Plain
`npm install` floats transitive deps to the latest version matching
the semver range and can drift from what's pinned -- a "passes
locally" claim against drifted `node_modules` is not equivalent to
"passes on CI." After the initial `npm ci`, plain `npm test` is fine
for the iteration loop.

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
- **Content Security Policy** - enforced (see `DESIGN_SPEC.md` -> Security).
  Two practical rules for contributors:
  - **Touching `src/index.html` inline `<script>` or `<style>` blocks**
    requires running `npm run lint:csp-hashes` (also runs in `npm run lint`)
    and pasting the new SHA-256 hash into `script-src` in
    `staticwebapp.config.json`. The post-build `--dist` mode catches the
    same drift against the served bytes.
  - **Adding any new external origin** the SPA talks to (analytics
    pipeline, identity provider, CDN, font host, image host, iframe,
    websocket) requires updating the corresponding CSP directive
    (`connect-src`, `frame-src`, `font-src`, `img-src`, etc.) in the
    same change. CI's `--ci-origins` mode validates the secret-baked
    auth and App Insights origins, but other directives are
    contributor-enforced.
- **`staticwebapp.config.json` non-CSP assertions** - `scripts/check-swa-config.mjs`
  (lint chain) covers the rest of the file: the non-CSP `globalHeaders`
  entries (`X-Frame-Options`, `X-Content-Type-Options`,
  `Strict-Transport-Security`, `Referrer-Policy`, `Permissions-Policy`),
  the `navigationFallback.rewrite` value (`/shell.html`), the
  `navigationFallback.exclude` extension set (`/api/*` plus the canonical
  static-asset extensions, with brace-group expansion so contributors
  can split `*.{js,css}` without tripping the gate), the `/api/*`
  `allowedRoles` (must include `anonymous`), route-order shadowing (no
  wildcard route may precede the must-revalidate Cache-Control rules),
  the four `Cache-Control: no-cache, must-revalidate` rules
  (`/index.html`, `/shell.html`, `/404/index.html`, `/ngsw.json`),
  `platform.apiRuntime` (must be in the small allowlist of currently-
  supported Node versions), and the `.webmanifest` MIME type. The
  validator works against the source file; it does NOT prove the CDN
  serves what the file describes - that's tracked under issue #179
  (PR preview environments).

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
   `check-spec-patterns.mjs`, `check-prod-patterns.mjs`,
   `check-lockfile.mjs`, and `check-format.mjs` (the prettier
   annotation wrapper - `npm run format:check` is the equivalent for
   direct invocation).
   Formatting is enforced repo-wide, including `api/**`, from the
   root. The `api/` lint is `tsc --noEmit`. ESLint is not installed.

   Each gate also has its own per-script entry point. CI runs most
   of them as separate steps with inline annotations and a per-gate
   summary: `npm run lint:tsc`, `npm run lint:ascii`,
   `npm run lint:spec-patterns`, `npm run lint:prod-patterns`,
   `npm run lint:format`. (The `lint:lockfile` gate is
   intentionally **not** a separate CI step: CI's job-level
   `npm ci` already enforces lockfile-vs-manifest sync natively, so
   a duplicate CI step would never fire. The script exists as a
   `lint:*` entry point so it shows up in `lint:all` and can be
   invoked directly during local debugging.) **When CI fails, look
   at the failing step's name in the run page** - the gate that
   broke is named directly (e.g., "Lint - Prettier formatting").
   The "Lint summary" rollup step at the end of the job restates
   which gate failed and the exact fix command. File-level (and
   where available, line-level) failures are surfaced as inline
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
2. `npm test` passes (frontend and `api/`). For changes touching
   `scripts/*.mjs`, also `npm run test:scripts` (Node-built-in unit
   tests; runs automatically as part of `npm run verify:fast` and
   the `web` CI job).
3. `npm run build` (or `ng build --configuration production`) succeeds.
4. `npm run lint:ascii` passes (no new non-ASCII codepoints outside the
   allowlist in `scripts/check-ascii.mjs`).
5. `npm run format` to reformat changed files (or rely on editor
   format-on-save). `npm run format:check` is a read-only equivalent
   that runs as part of `npm run lint`.
6. Only run the suites that exist - do not introduce new toolchains to satisfy
   this checklist. If a suite isn't set up yet and the task is scaffolding,
   set it up per the spec.
7. No new TypeScript errors or console warnings introduced.
8. Spec is updated if behavior or architecture changed.
9. **`why-jotjson.md` updated when user-facing features change.**
   [`why-jotjson.md`](why-jotjson.md) is the public pitch doc shared
   with prospective users to answer "why should I use JotJSON?" When
   a change adds, removes, or significantly alters a user-facing
   feature, update it in the same PR. Backend, infra, refactoring,
   and bug-fix changes typically do not require an update. Genuinely
   novel features (those competing JSON tools don't have) go in the
   "Things you can't get elsewhere" section; standard features get a
   one-line bullet under "Plus the basics, done well."
10. Telemetry decision recorded: explicitly decide whether the change
    warrants a telemetry event. If you add one, ensure the messageId
    is registered (frontend), the emit-shape spec is in place, and
    `docs/telemetry.md`'s Backend events table is updated for backend
    events. See §4 Telemetry.
11. **SemVer bump decision recorded.** Before committing, decide
    explicitly whether the change warrants a SemVer bump per
    `DESIGN_SPEC.md` -> Versioning -> SemVer bump rules. If yes, edit
    `package.json` in the same commit. If no, state "no bump" in the
    response (and ideally in the commit body) so the decision is on
    the record. The build counter + SHA already give per-deploy
    resolution, so most non-feature work is "no bump."
12. **Never use `npm install --legacy-peer-deps` or `--force`** to
    work around peer-dependency installation errors without explicit
    user approval. These flags are known lockfile-drift attractors:
    they skip recording transitive optional-peer entries that
    `npm ci` on Linux later rejects, breaking CI for everyone (see
    retro: M7h CI break, fix in commit 78c0dd7). If npm refuses an
    install on peer-dep grounds, stop and ask the user whether to
    bump the conflicting package, pin a different version, or accept
    the override - do not work around silently.

    If the user does approve an override, it must be persisted before
    commit by either:
    - committing the matching flag in `.npmrc` at the workspace root
      (so subsequent `npm ci` runs use the same resolution), or
    - regenerating the lockfile afterward with the override removed
      (`Remove-Item package-lock.json; npm install --package-lock-only`)
      so the committed lockfile is valid under default settings.

    Either way, `npm run lint:lockfile` (which runs `npm ci --dry-run`
    against root and `api/`) must pass before commit. The `lint`
    chain runs it automatically, so this is enforced by `lint:all`.

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
- **NEVER bypass branch protection.** Do not use `gh pr merge --admin`,
  `--force`, or any other flag/UI/API path that bypasses required
  reviews, required status checks, or unresolved review-thread blocks.
  This rule has zero exceptions, including:
  - When the user owns the repo and `--admin` would technically work.
  - When the change "looks trivial" (a comment-only edit, a typo fix).
  - When CI is "obviously" green and the only block is an unresolved
    review thread or missing approver.
  - When the user is unavailable and the PR has been sitting.
  - When you have local user approval to merge -- that is not the same
    as approval to **bypass policy**. The policy exists for the human
    workflow gates (review, conversation resolution, required checks);
    user-of-the-moment consent does not waive those gates.

  If a PR is blocked, surface the block in plain language (which gate
  is failing, e.g., "1 unresolved review thread", "review required",
  "1 of 10 checks pending"), explain how it can be cleared (resolve
  thread, request review, wait for CI), and stop. Do not propose
  `--admin` as an option in `ask_user`. The user can clear the block
  themselves through the GitHub UI; agents do not bypass it.
  (Resolving review threads the agent has legitimately addressed with
  a pushed commit is a different action -- see "Responding to PR
  review feedback" below.)
- **Auto-update of PR branches.** `main` is protected with `strict: true`
  on classic branch protection (require branches to be up to date before
  merge). A Mergify GitHub App install, configured by `.mergify.yml` at
  the repo root, auto-pushes a merge of `main` into the PR head whenever
  an open non-draft, non-conflicting PR targeting `main` is behind. This
  fires the PR's normal `pull_request: synchronize` event, re-runs CI,
  and lets GitHub's native auto-merge land the PR when green. Net
  effect: enabling auto-merge once is sufficient -- no manual "Update
  branch" click is needed when `main` advances. Rollback is uninstalling
  the Mergify app + deleting `.mergify.yml`.
- When a commit is authored with AI assistance, include:

  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```

- When opening or triaging an issue, apply exactly one priority label:
  `priority:high`, `priority:medium`, or `priority:low`. These three
  labels are the only priority signal in the repo (we do not use a
  Project board field). Existing kind/area labels (e.g., `bug`,
  `accessibility`, `tech-debt`, `ux`) are orthogonal and still apply.

### PR descriptions for agent-authored PRs

When the **Copilot CLI runtime** opens a PR -- **or pushes commits
to an open PR that does not yet have a Session block for the
current session** -- append a **Session** block to the end of the
PR description so the user can resume the same session to address
review feedback:

```
---
**Session**
- AI-Local: `<local-session-id>`
- AI-Cloud: `<cloud-session-id>`
```

The `AI-` prefix marks these as agent-runtime identifiers so they
are greppable and unambiguous.

Canonical sources for the Copilot CLI runtime:

- `workspace.yaml` -> `id` for `AI-Local`
- `workspace.yaml` -> `mc_session_id` for `AI-Cloud`

`workspace.yaml` lives at the root of the agent's session folder
(typically `~/.copilot/session-state/<local-session-id>/`). Never
invent values. If a CLI session genuinely lacks one of these fields
(e.g., a corrupted workspace.yaml), omit the matching line and add
a one-line note in the PR description explaining what is missing
and why.

**Before appending**, fetch the current PR description (e.g.,
`gh pr view <num> --json body`) and check whether a Session block
for the **current** session's `AI-Local` / `AI-Cloud` pair is
already present. If yes, skip -- do not duplicate. If a Session
block from a *different* session is present, **append** a new
block rather than overwriting; the history of which sessions
touched the PR is useful context.

This rule applies only to the Copilot CLI runtime. Other agent
runtimes (e.g., Copilot Coding Agent) have different session-ID
semantics and are out of scope for this rule until added
explicitly.

### Responding to PR review feedback

Review comments -- from humans **and** from bots
(`copilot-pull-request-reviewer[bot]`, dependabot, code-scanning
agents, etc.) -- are **proposals**, not orders. Apply the §11
critical-thinking and rubber-duck pipeline to every substantive
comment before responding.

- **Treat reviewer comments like user suggestions.** Evaluate each
  comment against `DESIGN_SPEC.md`, the approved plan, and existing
  conventions. If a comment conflicts with the spec, the plan, or
  a deliberate prior decision, **push back with a reasoned reply**
  -- do not silently rewrite the code to match. Acceptance is the
  default for clearly-correct comments (typo, missing null check,
  broken link); critical evaluation is mandatory for everything
  else.
- **Bot comments carry no special authority.** A comment from
  `copilot-pull-request-reviewer[bot]`, dependabot, a code-scanning
  tool, or any other automated reviewer gets the *same* treatment
  as a human comment -- no more, no less. A bot's confident tone
  is not a reason to skip the rubber-duck step or to action a
  suggestion that conflicts with the spec.
- **One reasoned pushback then escalate.** If you post a pushback
  reply to a bot comment and the bot re-asserts the same concern,
  do **not** loop into another rubber-duck/reply cycle. Escalate
  to the user (or merging maintainer) with a one-paragraph summary
  of the disagreement and stop. This prevents adversarial-bot
  loops that consume turns without resolution.
- **Distinguish in-scope vs out-of-scope feedback.** A comment is
  **in-scope** if and only if the proposed fix would preserve the
  approved plan's **public API, stored shape, user-visible
  behavior, and design intent** -- i.e., it points out a flaw in
  *how* the plan was implemented (a bug in the change, a missed
  edge case, a convention violation, a missing null check, a
  naming-convention nit). Address in-scope comments directly after
  the rubber-duck step. A comment is **out-of-scope** if the
  proposed fix would change the approved API, stored shape,
  user-visible behavior, or design intent, **or** if it requires
  unrelated refactoring (a refactor, a new feature, a different
  design choice, a renamed file, a "while you're here, also
  change..." request). Treat out-of-scope comments as a new
  plan-trigger per §11: post a reasoned response on the PR and do
  **not** push a fix without fresh user authorization. When
  uncertain whether a comment is in-scope or out-of-scope, treat
  as out-of-scope. In CLI mode, seek authorization via `ask_user`.
  In cloud-coding-agent mode without a live user channel, post
  the proposed response/plan as a PR comment and **stop** until
  the user or merging maintainer explicitly authorizes proceeding
  -- silence is not authorization.
- **Rubber-duck before responding to substantive comments.**
  Substantive comments (any non-trivial code change) require the
  §11 rubber-duck pipeline before you respond. You may batch
  related substantive comments and rubber-duck them together
  (e.g., five comments about the same function get one
  rubber-duck pass, not five). **Trivial comments may be actioned
  directly without rubber-ducking**, where "trivial" is narrowly
  scoped to: an obvious typo or grammar fix in a code comment or
  documentation; a broken-link fix; a lint nit produced by an
  automated tool (e.g., naming-convention rename, missing
  semicolon, import order). User-facing string changes are
  **never** trivial (they require i18n extraction per §4) even
  if the change is one line. When uncertain whether a comment is
  trivial, treat as substantive and rubber-duck.
- **Resolve threads only AFTER pushing the addressing commit, and
  verify the fix landed.** Never resolve a thread before the
  addressing commit is pushed. After pushing, **always** resolve
  the thread -- reviewer bots do not return to verify, so leaving
  addressed threads open is noise that hides genuine unresolved
  items. For pushback-only responses (no code change), resolve
  only after the user or merging maintainer has accepted the
  reply; do not unilaterally resolve a thread on a comment you
  disagreed with. Before resolving, re-read the thread and confirm
  the pushed change (or accepted reply) actually addresses what
  was raised.

  **Resolving an addressed thread is not bypassing a
  branch-protection block.** The existing rule above ("The user
  can clear the block themselves through the GitHub UI; agents do
  not") prohibits unilateral bypass via `--admin` / `--force` --
  it does not prohibit resolving a thread the agent has
  legitimately addressed with a pushed commit. The two actions
  are distinct: bypass overrides a policy gate; thread resolution
  signals that the work the reviewer requested is complete.

- **Never bypass branch protection to "clear" unresolved threads.**
  Restated from the rule above: if a PR is blocked by *unresolved*
  threads (i.e., threads where you have not pushed an addressing
  commit or do not have accepted pushback), the path forward is to
  resolve them with fixes or accepted pushback replies -- never
  `gh pr merge --admin`, `--force`, or any other bypass. Zero
  exceptions, including bot threads on trivial-looking comments.

### Auto-merge

Auto-merge (`gh pr merge --auto`) is the policy-compliant way to
indicate "this PR should land once gates pass". It is **not** a
bypass: GitHub holds the merge until all required gates (reviews,
conversation resolution, required status checks) pass, then
merges automatically. (If all gates are already satisfied when
you enable auto-merge, GitHub will merge **immediately** -- so
only enable auto-merge when you actually want the merge to
proceed.) Compare to `gh pr merge --admin`, which IS a bypass and
is prohibited under all circumstances (see the branch-protection
rule above).

**Default: OFF.** The agent does not enable auto-merge on its own
judgment. The user merges manually, or explicitly authorizes
auto-merge per PR.

**Enable auto-merge only when all of the following are true:**

- The user has **explicitly authorized merging this PR** with an
  unambiguous verb-led phrase: "ship it", "auto-merge it",
  "approve and merge", "merge when green", or equivalent. Per
  **§10 "Discussion is not approval"**, ambiguous conversational
  signals ("looks good", "go ahead", "yes") do **not** count. If
  you are unsure whether a phrase qualifies, ask via `ask_user`;
  do not enable auto-merge on a guess.
- The authorization applies to the **current state** of the PR.
  If the user's authorization is combined with new requested
  scope ("ship it after adding X"), complete the new scope first,
  rerun the §7 DoD checks, rubber-duck the final diff, then seek
  **fresh authorization** for the new final state.
- All intended commits for this PR have been pushed. Do not
  enable auto-merge while still iterating on the changeset.
- The PR is not a draft.
- The §7 Definition-of-Done checks pass locally (lint, test,
  build, for both root and `api/`).
- You have rubber-ducked the **final state** of the PR -- not
  just the plan (the final state may differ if rubber-ducked
  review feedback changed the diff).

If any criterion is unmet, do not enable auto-merge. Surface what
is missing in plain language and wait for the user, exactly as
you would for a branch-protection block.

Use the squash strategy -- this repo only permits squash merges
(`allow_squash_merge: true`, others false):

`gh pr merge <number> --auto --squash`

**Proactive recommendation for low-risk classes.** For PRs in the
following narrowly-defined low-risk classes, the agent **should**
recommend auto-merge in the PR description (e.g., a one-line
"Recommend auto-merge once CI passes -- reply 'ship it' to
enable.") so the user does not have to ask:

- **Docs-only**: changes to `*.md`, `docs/**`, or comments inside
  config files. No executable or runtime behavior touched (no logic,
  no schemas, no build steps, no tests).
- **Lint/format-only**: changes produced by an automated
  formatter or linter with no semantic diff (e.g., prettier
  rerun, import reorder).
- **Patch-level dev-dependency bumps** from dependabot or
  equivalent, where the lockfile is the only meaningful change,
  the dependency is in `devDependencies` (not `dependencies`),
  and CI passes.
- **Typo fixes in code comments only** -- not in user-facing
  strings, which go through Angular i18n (§4) and require
  `messages.xlf` regeneration.

**Anti-lawyering rule:** if any touched file or hunk falls outside
its low-risk class, the **whole PR** is outside the class. A
"docs-only" PR that also touches a `.ts` file is not docs-only;
do not proactively recommend auto-merge.

For any PR outside these classes -- new features, refactors,
behavior changes, infra, schema changes, test
additions/removals, anything that changes a public API or stored
shape -- the agent should **not** recommend auto-merge
proactively. Let the user decide unprompted.

**After enabling auto-merge**, keep it enabled only for **purely
mechanical** follow-up commits:

- Lint or format touch-ups produced by an automated tool.
- Comment-only edits (changes to code comments or doc files).
- The literal text change a reviewer requested for a trivial
  issue (typo or broken link **in a code comment or doc file
  only** -- never in a user-facing string, which requires i18n
  per §4 and is substantive even if one line), with no
  surrounding logic touched.

For any non-mechanical follow-up (additional code, scope
expansion, refactor, new tests with new assertions, behavior
change, **any user-facing-string change**), **disable auto-merge
first** (`gh pr merge <num> --disable-auto`), push the commit,
then either seek fresh merge authorization or leave auto-merge
off and let the user re-enable. This prevents the case where
auto-merge silently merges code the user never approved.

**Recovery if you forget to disable.** If you push a substantive
follow-up commit while auto-merge is still enabled:

1. Immediately run `gh pr merge <num> --disable-auto`.
2. Disclose the mistake in plain language to the user (in the
   next response or as a PR comment) -- name the commit and why
   it should have triggered a disable.
3. Seek fresh merge authorization before re-enabling auto-merge.

If the PR has already merged before you can disable, do **not**
silently move on. Report the merge to the user with the same
disclosure (which commit, why it was substantive, what gates
ran) and ask whether to revert, follow-up-fix, or accept.

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
- **Plans that change the shape of a Cosmos document must specify a
  schema-evolution approach.** Renames, removals, reshapes, and
  additions of stored fields each have a defined playbook in
  `DESIGN_SPEC.md` -> Versioning -> Schema evolution. The plan must
  state which shape the change is and which playbook step it lands at
  (e.g., "rename, step 1 + step 2: land canonical shape and add
  read-side fold").
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
- **CI failures are plan-triggers, not retry-triggers.** Never
  re-run a failed CI job, "Re-run all jobs", or push a
  speculative fix on the agent's own judgment when CI is red,
  even when the changeset on the run looks obviously unrelated
  to the failing test. **On `main`, this is zero-tolerance**:
  never autonomously retry a red CI run, full stop. On PR and
  feature branches the same no-autoretry rule applies, but you
  may at least propose a retry as part of a plan -- still
  subject to user authorization before acting. The default
  response to any CI failure is: tell the user the job failed,
  summarize what broke (which job, which test or step, the
  assertion or exit code, what the changeset on the run
  actually touched), and ask what to do. When the failure
  looks like a flake, propose filing a `flaky-test` issue so
  it can be hardened rather than re-running silently -- silent
  retries hide both genuine flakes (so they never get fixed)
  and genuine regressions (so they ship anyway, with a green
  second attempt covering for the red first attempt). The
  direct-command carve-out applies only when the user has
  issued an explicit retry instruction in the same or a recent
  turn (e.g., "re-run that job", "rerun the failed attempt",
  and similarly explicit retry instructions); the agent's own
  judgment that "this is probably a flake" is not such a
  command. This rule is distinct from the fix-and-push rule
  for agent-caused breakage: when the agent's own change broke
  CI on `main`, the agent must still push the fix and watch
  the re-run go green before declaring the task done. That
  rule is about *fixing* known breakage caused by the agent;
  this one is about not *retrying* unknown failures on a hunch.
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

