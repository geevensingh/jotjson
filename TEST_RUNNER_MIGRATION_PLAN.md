# Plan: Migrate Karma + Jasmine -> Vitest

## Problem

Angular 21 deprecated Karma as the default test runner. New Angular projects
ship with Vitest + jsdom, and the `@angular/build:unit-test` builder is the
forward path. We are currently on Karma + Jasmine with 296 passing specs.
Goal: migrate to Vitest without losing coverage or regressing behavior.

## Honest risk assessment (read first)

**Angular's own docs mark this migration as EXPERIMENTAL.** Quoting
angular.dev: "Migrating an existing project to Vitest is considered
experimental." This is not a routine update.

Concrete obstacles in our codebase:

1. **Monaco editor tests (home.component.spec.ts) are browser-only.**
   Monaco relies on the AMD loader and Web Workers - it does not run
   under jsdom. Options: (a) run Monaco-touching specs under Vitest's
   browser mode via `@vitest/browser-playwright` (adds Playwright
   toolchain to CI/devloop), or (b) mock Monaco at the module boundary
   and only exercise the component's logic, not the editor itself.

2. **33 `fakeAsync` / `flush` / `tick` occurrences across 4 spec files**
   (home, auth.interceptor, clipboard-polling, preferences). **Vitest does
   NOT support these zone.js-based helpers.** Each site must be rewritten
   to native `async/await` plus `vi.useFakeTimers()` / `vi.advanceTimersByTime()`.
   The schematic does NOT handle this.

3. **~120 `jasmine.*` / `spyOnProperty` / `createSpy` references.** The
   `refactor-jasmine-vitest` schematic handles most of these, but it's
   also flagged experimental and does not cover complex spy scenarios.

4. **karma.conf.js + test.ts + all karma-* dev deps must be removed** and
   replaced with Vitest config + jsdom (or happy-dom) + optional Playwright
   browser provider. `ng test --coverage` replaces the karma-coverage
   config.

5. **CI workflow updates**: GitHub Actions workflows that invoke
   `npm run test:ci` currently expect Karma's ChromeHeadlessCI. The new
   `ng test` auto-detects CI env; scripts need to be trimmed.

None of this is a blocker, but it's NOT a "flip a switch" task. A bad
migration can silently skip tests (e.g., fakeAsync calls that now no-op
instead of advancing time) - so the validation strategy below is
explicit about detecting silent regressions.

## Approach: prove-it-works spike, then cut over

Rather than a single big-bang migration, run a **proof-of-concept first**
on a representative subset, validate, then migrate the rest. This lets us
abandon the migration with minimal cost if Vitest turns out to not
handle our tests well.

### Phase 0: Spike (throwaway branch, no commits to main)

1. Create a local spike branch.
2. Pick **3 representative specs** to convert manually:
   - `preferences.service.spec.ts` (has fakeAsync, pure logic)
   - `clipboard-polling.service.spec.ts` (has timers, navigator stubs,
     the pattern used by other clipboard-adjacent tests)
   - `toolbar.component.spec.ts` (Angular component with inputs, no
     Monaco, no router)
3. Set up minimal Vitest config, install deps, port these three.
4. Validate: all three pass, coverage output sane, watch mode fast,
   debugging works.
5. **Decision gate**: if any of those three fail in ways we can't
   resolve in ~1-2 hours, abort the migration - report back with the
   blocker and keep Karma. If they pass, proceed to Phase 1.

### Phase 1: Infrastructure setup (main branch)

1. Install `vitest` + `jsdom` as dev deps. Leave Karma deps in place
   for now (we'll run both temporarily).
2. Add a second `test:vitest` script pointing at the Vitest runner via
   `ng test` with the `@angular/build:unit-test` builder. Keep the
   existing `test` script (Karma) as-is.
3. Add `builder: "@angular/build:unit-test"` as a **new test target**
   in `angular.json` (e.g., `test-vitest`) so both can coexist.
4. Add `tsconfig.spec.json` adjustments if needed (check if Vitest
   needs different module resolution).
5. Add `vitest.config.ts` if we need custom setup (global mocks for
   Monaco, navigator, etc.).
6. Verify one spec passes under the new builder before moving on.
7. Commit as `Add Vitest runner alongside Karma (coexistence)`.

### Phase 2: Automated schematic pass

1. Run `ng g @schematics/angular:refactor-jasmine-vitest --verbose`.
2. Review every file it touched. The schematic adds TODO comments for
   things it couldn't convert - those are our manual task list.
3. Run Karma: tests should still pass (schematic output is
   backward-compatible with Jasmine syntax for simple cases, but
   check).
4. Run Vitest: expect failures - fakeAsync-using specs, Monaco specs.
5. Commit as `Apply refactor-jasmine-vitest schematic` - even if some
   tests fail, this is mechanical progress worth checkpointing.

### Phase 3: Manual rewrites

For each of the 4 fakeAsync-using spec files:

1. Replace `fakeAsync(() => { ... tick(500); ... })` with
   `async () => { ... vi.useFakeTimers(); ... vi.advanceTimersByTime(500); ...`
   or equivalent native async patterns.
2. Replace `flush()` with `await vi.runAllTimersAsync()` or explicit
   promise flushing.
3. Replace `waitForAsync` wrappers with native `async/await`.
4. Confirm each spec passes under Vitest and still passes under Karma
   (until we drop Karma).

For the Monaco-dependent home.component.spec.ts:

- **Decision needed**: mock Monaco entirely at the module boundary
  (preferred - keeps tests in jsdom for speed) OR enable browser mode
  for that spec only (heavier, slower, requires Playwright in CI).
- Recommendation: **mock Monaco**. The existing spec already logs
  "Monaco failed to load" errors under Karma and tests around that -
  the actual editor is tested by manual QA anyway.

Commit in small batches: one spec file per commit where practical.

### Phase 4: Cutover

1. Delete `karma.conf.js`, `src/test.ts`.
2. Uninstall Karma deps: `karma`, `karma-chrome-launcher`,
   `karma-coverage`, `karma-jasmine`, `karma-jasmine-html-reporter`,
   `@types/jasmine`, `jasmine-core`.
3. Remove `@angular/build:karma` test target config from
   `angular.json`, keeping only the Vitest target. Rename to the
   default `test` name.
4. Update `package.json` scripts: `test`, `test:ci` point at Vitest
   (the `ng test` command auto-detects CI, so `--watch=false` may
   drop to just `ng test`).
5. Update GitHub Actions workflow(s) that run tests - usually just a
   script name swap, but verify.
6. Commit as `Remove Karma; Vitest is the only test runner`.
7. Push.

### Phase 5: Validation (comprehensive)

Because silent test regressions are the biggest risk:

1. **Count parity**: Vitest must report "296 tests" (or our final
   count) - a big drop means specs got silently skipped.
2. **Coverage parity**: `ng test --coverage` branches/lines numbers
   should be in the same ballpark as the Karma baseline. A big drop
   means tests are executing but assertions aren't firing.
3. **fakeAsync audit**: grep the codebase for any surviving
   `fakeAsync`, `tick`, `flush`, `waitForAsync` - should be zero.
4. **Actually break a test**: change an assertion to wrong value in
   one spec per file, confirm Vitest detects the failure. This is
   paranoia but it's how we catch schematic bugs.
5. Smoke-test the app (`npm start`): nothing in the runtime app
   should be affected by this migration, but verify.

## What this plan explicitly does NOT do

- Switch to `happy-dom` over jsdom (start with default, swap later
  only if perf demands).
- Use Vitest browser mode (keeps the toolchain simpler; only
  introduce if Monaco mocking proves insufficient).
- Convert Monaco visual/keyboard tests to Playwright E2E (would be
  valuable but is a separate project).
- Rewrite the api (Jest) test suite - this plan is frontend only.

## Rollback

Each phase is one or more small commits. Phase 0 (spike) has no main-branch
commits. Phases 1-3 leave Karma in place, so a `git revert` of any
Vitest-related commit keeps tests green. Phase 4 is the irreversible
one; don't merge Phase 4 until Phase 5 validation is clean. If we
abort mid-migration we end up with dual-runner setup, which is ugly
but functional.

## Open decisions for the user (answer before starting Phase 1)

1. **Accept the experimental status?** Angular officially calls this
   experimental. Proceed, or wait for GA? (Recommendation: wait unless
   there's a concrete driver. See "Trigger to start" below.)

2. **Monaco strategy: mock at module boundary OR browser mode?**
   (Recommendation: mock at boundary.)

3. **Single-runner in a single PR, or stepwise commits on main?**
   (Recommendation: stepwise. Phase 1 coexistence commit, then each
   spec file as its own small commit, then Phase 4 as the final
   switchover.)

4. **Acceptable duration for Phase 3?** 4 fakeAsync files + ~20
   complex specs means real developer hours of manual rewrite.
   Concrete number is hard to estimate because of the experimental
   schematic's unknown coverage.

## Trigger to start

I recommend **waiting to execute this plan until at least one** of:

- Vitest support is marked stable (not experimental) by Angular.
- We have a concrete pain point with Karma (broken CI, security
  advisory, Angular major actually drops Karma support entirely).
- We're already rewriting large portions of the test suite for
  another reason and can fold migration into that work.

In the meantime, Karma still works and is supported on Angular 21.
This plan stays on-file as ready-to-execute.

## Todos (when we're ready to start)

1. `spike` - Phase 0: 3 specs converted on throwaway branch.
   Decision gate.
2. `vitest-infra` - Phase 1: install deps, add coexisting test target.
3. `schematic-pass` - Phase 2: run `refactor-jasmine-vitest`, review,
   commit.
4. `rewrite-fake-timers` - Phase 3a: rewrite fakeAsync/tick/flush in
   4 spec files.
5. `mock-monaco` - Phase 3b: add Monaco module mock; verify home
   component tests pass under Vitest.
6. `fix-remaining-specs` - Phase 3c: clean up any specs the
   schematic left TODOs in.
7. `cutover` - Phase 4: delete Karma, rename target, update scripts +
   CI workflow.
8. `validate` - Phase 5: count/coverage/fakeAsync/canary checks +
   smoke-test.
