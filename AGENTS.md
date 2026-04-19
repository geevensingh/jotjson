# Agent Instructions — JotJSON

These are the default instructions for any AI coding agent (Copilot CLI, Copilot
coding agent, Cursor, Claude Code, etc.) working in this repository. Follow them
unless a task explicitly overrides a specific rule.

## 1. Source of Truth

- **`DESIGN_SPEC.md` is the authoritative product & architecture spec.** Read
  the relevant sections before making non-trivial changes. If a request
  contradicts the spec, flag the conflict before implementing.
- Do not silently deviate from the spec (entities, routes, SKUs, limits,
  defaults). If a change is needed, update `DESIGN_SPEC.md` in the same PR.

## 2. Tech Stack (non-negotiable defaults)

- **Frontend:** Angular (latest LTS), standalone components, Angular Signals for
  state, Angular Material for UI, Angular Router with lazy-loaded features,
  MSAL Angular for auth, SCSS for styles.
- **Editor:** Monaco (lazy-loaded). JSON/JSONC parsing via `jsonc-parser` — do
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

Follow the Angular layout in `DESIGN_SPEC.md` → *Project Structure*:

```
src/app/{core,shared,features}/...
infra/                 # Bicep
api/                   # Azure Functions (TypeScript)
.github/workflows/     # CI/CD
```

Place new code in the correct bucket:
- Singleton services / guards / interceptors → `core/`
- Reusable UI / pipes / directives → `shared/`
- Page-level features → `features/<name>/`

## 4. Coding Conventions

### TypeScript (frontend + functions)
- `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`. Never disable
  with `any` — use `unknown` + narrowing.
- Prefer `type` for unions/aliases, `interface` for object contracts that may be
  extended.
- No default exports in app code (except Angular-required cases).
- Async code uses `async/await`, not raw Promise chains.
- Never swallow errors. Log + rethrow or surface to the user via toast.

### Angular
- **Standalone components** only; no `NgModule`s for new code.
- Use **Signals** for component state; RxJS only at I/O boundaries (HTTP,
  routing, events).
- Use `inject()` over constructor DI for new code.
- Components: `OnPush` change detection by default.
- Template logic stays trivial — push branching into the component or a pipe.
- Styles are component-scoped SCSS. Global tokens live in `src/styles/`.
- Theming uses the `TreeHighlightColors` / theme tokens from the spec — do not
  hardcode colors in components.

### Internationalization (i18n)
- v1 ships in English only, but **all user-facing strings must be extractable**
  per `DESIGN_SPEC.md` §Internationalization.
- Template text, attribute values (including `matTooltip`, `aria-label`,
  `title`, `placeholder`), and visible labels use Angular `i18n` attributes
  with a stable ID, e.g., `i18n="@@toolbar.paste.tooltip"`. Non-text attributes
  use `i18n-<attrname>="@@id"`.
- TS/Runtime strings (toast messages, logs that are visible to users, aria
  labels bound via expressions) use `$localize` tagged template literals with
  a stable ID, e.g., ``$localize`:@@upload.tooLarge:File too large — max 5 MB` ``.
- Stable ID convention: `<area>.<element>.<purpose>` in camelCase / dot
  segments (e.g., `@@tree.search.placeholder`, `@@home.empty`).
- Never use plain strings in templates or `console.warn`/`toast` calls when
  they are user-visible.
- Run `npm run extract-i18n` to refresh `src/locale/messages.xlf` when you add
  or change strings.

### Azure Functions
- One function per folder. Keep handlers thin; put logic in `src/lib/`.
- Validate all inputs (zod or equivalent schema validation).
- Return typed JSON responses with explicit status codes. Never leak stack
  traces.
- Auth: validate B2C-issued JWTs on every protected route.

### Naming
- Files: `kebab-case.ts`. Angular: `thing.component.ts`, `thing.service.ts`,
  `thing.pipe.ts`, `thing.guard.ts`.
- Classes: `PascalCase`. Variables/functions: `camelCase`. Constants: `UPPER_SNAKE`.
- Test files: co-located as `*.spec.ts`.

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
- All API routes that mutate or read user data require a valid B2C token except
  the explicitly-public blob read path.

## 7. Definition of Done

Before finishing a task:
1. `npm run lint` passes (frontend and `api/`).
2. `npm test` passes (frontend and `api/`).
3. `npm run build` (or `ng build --configuration production`) succeeds.
4. Only run the suites that exist — do not introduce new toolchains to satisfy
   this checklist. If a suite isn't set up yet and the task is scaffolding,
   set it up per the spec.
5. No new TypeScript errors, ESLint errors, or console warnings introduced.
6. Spec is updated if behavior or architecture changed.

## 8. Git & PR Hygiene

- Small, focused commits with imperative subject lines (e.g.,
  `Add slug collision check to BlobService`).
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
  defaults, limits, or scope.
- Prefer the simpler, spec-aligned option over a clever alternative.
