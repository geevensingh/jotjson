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
- Logging: use `LoggerService` (`src/app/core/telemetry/logger.service.ts`)
  for any log a developer might consult. Direct `console.*` calls in
  production code are permitted only in `src/app/core/telemetry/` and
  `src/main.ts` (early-boot bootstrap errors). Test files (`*.spec.ts`,
  `*.test.ts`) may reference `console.*` for spies and expectations.

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

### Naming
- Files: `kebab-case.ts`. Angular: `thing.component.ts`, `thing.service.ts`,
  `thing.pipe.ts`, `thing.guard.ts`.
- Classes: `PascalCase`. Variables/functions: `camelCase`. Constants: `UPPER_SNAKE`.
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

## 5. Testing

- **Always add/update tests** for logic changes. No test = not done.
- Frontend: **Karma + Jasmine** (configured via `karma.conf.js` with a
  `ChromeHeadlessCI` launcher for GitHub Actions). Run with `npm test`
  locally and `npm run test:ci` in CI (adds `--code-coverage`). Co-locate
  specs as `*.spec.ts` alongside the unit under test.
- Functions: Jest with mocked Cosmos / Blob clients.
- Test names describe behavior: `it('returns 404 when blob slug is unknown')`.
- Run the full lint + test + build suite before declaring completion (see §7).

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

Before finishing a task:
1. `npm run lint` passes (frontend and `api/`). Lint is currently
   `tsc --noEmit` plus `check-ascii.mjs` and `check-spec-patterns.mjs`;
   ESLint is not yet installed.
2. `npm test` passes (frontend and `api/`).
3. `npm run build` (or `ng build --configuration production`) succeeds.
4. `npm run check:ascii` passes (no new non-ASCII codepoints outside the
   allowlist in `scripts/check-ascii.mjs`).
5. Only run the suites that exist - do not introduce new toolchains to satisfy
   this checklist. If a suite isn't set up yet and the task is scaffolding,
   set it up per the spec.
6. No new TypeScript errors or console warnings introduced.
7. Spec is updated if behavior or architecture changed.

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
  defaults, limits, or scope. **Always ask and wait for the user's
  answer -- even if the runtime reports the user as unavailable, busy,
  or away. Never assume an answer or proceed autonomously with a plan
  based on a guess.**
- Prefer the simpler, spec-aligned option over a clever alternative.
