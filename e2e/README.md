# JotJSON e2e (Playwright)

This directory holds the Playwright-driven smoke e2e suite for JotJSON.
It is the **Smoke e2e (anonymous)** layer in `DESIGN_SPEC.md`'s Testing
strategy section, and a required v1 gate.

## What this suite is for

Catches regressions that unit tests and browser-integration specs
cannot:

- Production-bundle build correctness (lazy chunks, router, AOT).
- Editor (Monaco) mount and value roundtrip in a real DOM.
- Tree pane rendering of parsed JSON.
- `localStorage`-backed draft persistence across reload.
- Service-worker registration path on first paint.
- Preferences round-trip (theme switching + persistence).

## What this suite is NOT for

- **SWA-applied response headers** (CSP, X-Frame-Options) - those live
  in `staticwebapp.config.json` and only take effect on a deployed SWA
  host. Validating them needs a separate post-deploy smoke layer.
- **Real MSAL config behavior** - the e2e bundle is built against
  `environment.example.ts` (anonymous), not the secret-baked
  `environment.prod.ts`. Signed-in coverage is tracked in issue #68.
- **Cross-browser** (Firefox, WebKit) - issue #65, post-v1.
- **Visual regression** - issue #67, post-v1.

## Anonymous routes only

The Angular Router puts `/profile`, `/blobs`, `/history`, and
`/formatting-rules*` behind `authGuard` - those routes redirect away for
anonymous users. The smoke suite stays on routes reachable without
sign-in: `/` (home), `/s/:slug` (read-only share view), and `/404`.
Adding signed-in coverage is tracked in #68.

## Zero flake tolerance

JotJSON's testing norm is that flake is a P0 bug, not an inconvenience
to be retried away. The Playwright config therefore uses:

- `retries: 0` - no automatic re-runs.
- `workers: 1` - no parallel-test contention.
- `reducedMotion: 'reduce'` - deterministic timing across spec runs.
- Bounded action / navigation / `expect` timeouts.
- Locator-based readiness assertions (no `waitForLoadState('networkidle')`).

If a spec flakes:

1. Reproduce locally with `npm run test:e2e:ui` to inspect the run.
2. Fix the determinism issue - missing waiter, racing assertion,
   selector that matches multiple elements.
3. If the flake cannot be eliminated, **delete the spec**. A deleted
   spec is better than a flaky one because flake erodes confidence
   in the rest of the suite.

## Running locally

One-time setup:

```
npm install
npx playwright install chromium
```

Run all specs:

```
npm run test:e2e
```

Open the Playwright UI mode (great for debugging):

```
npm run test:e2e:ui
```

The Playwright config has a `webServer` entry that runs
`npm run build && npx serve --single dist/jotjson/browser -l 4173`
and waits for the port to come up. You don't need to start a server
manually.

If you already have a build server on port 4173, Playwright reuses
it locally (`reuseExistingServer: !CI`). On CI it always starts a
fresh server.

### Targeting a deployed environment

Set `PLAYWRIGHT_BASE_URL` to skip the local build/serve and run the
suite against a deployed environment instead:

```
PLAYWRIGHT_BASE_URL=https://<host>.azurestaticapps.net/ npm run test:e2e
```

This is how Phase 1's manual verification against the `nonprod` SWA
runs, and how `cd-preview.yml` (per-PR previews) will exercise the
same suite against each PR's preview URL. Whitespace-only values are
ignored; non-`http(s)` URLs fail config load.

## Debugging failures

On failure, Playwright writes:

- `playwright-report/` - HTML report (open `index.html` in a browser).
- `test-results/` - per-spec traces, videos, screenshots.

CI uploads both as artifacts on failure.

To view a trace locally:

```
npx playwright show-trace test-results/<spec-name>/trace.zip
```

## Adding a spec

1. Put the new spec under `e2e/anonymous/<flow-name>.spec.ts`.
2. Use accessible-name selectors first (`getByRole`, `getByLabel`),
   CSS selectors only as a last resort.
3. Wait for visible landmarks (`expect(locator).toBeVisible()`)
   before interacting - never use `waitForLoadState('networkidle')`.
4. Avoid the toolbar Paste button (`navigator.clipboard.readText` is
   a known browser-permission flake source). For editor input use
   `keyboard.insertText()` after `focus()` on the Monaco textbox.
5. Note that Monaco's role="textbox" sits below an overlay that
   intercepts pointer events; prefer `.focus()` over `.click()` when
   targeting the editor.
6. **Call `assertNoSeriousA11yViolations(page)`** (from
   `e2e/util/a11y.ts`) at the END of the spec, after the user-flow
   assertions and after the DOM has settled.
7. If a selector requires a non-trivial CSS path, consider whether
   the underlying component is missing an accessible name - that may
   be a pre-existing a11y bug worth fixing instead of papering over.

## CI integration

The `e2e` job in `.github/workflows/ci.yml` runs this suite on every
PR and on push-to-`main`. It:

1. Materializes `environment.ts` from `environment.example.ts`
   (anonymous config; no secret bake).
2. Builds the production bundle.
3. Caches `~/.cache/ms-playwright` keyed on OS + Playwright version.
4. Installs Chromium (no-op on cache hit).
5. Runs `npm run test:e2e`.
6. On failure, uploads `playwright-report/` and `test-results/`.

Realistic CI runtime: 4-5 min cold, 2-3 min warm (with browser cache).

## Accessibility coverage

The smoke suite runs `@axe-core/playwright` at the end of each spec via
`assertNoSeriousA11yViolations(page)` (in `e2e/util/a11y.ts`). The gate:

- Restricts to **WCAG 2 / 2.1 Level A and AA** rule tags (no
  `best-practice`).
- **Blocks merge** on `serious` or `critical` violations.
- Supports a **dated allow-list** (`ALLOW_LISTED_RULES`) for known
  framework limitations. Every entry has a `reviewBy` ISO date; the
  helper fails the gate as soon as any entry's date passes, forcing
  review rather than letting the allow-list rot.

Coverage in the current smoke set:

- `paste-and-reload.spec.ts` scans the loaded home page (editor +
  populated tree) in **`theme-light`** (`test.use({ colorScheme: 'light' })`).
- `theme-cycle.spec.ts` scans the loaded home page in **`theme-dark`**
  as its natural end state.
- Empty home, `/s/:slug` (read-only share view), and `/404` are NOT
  scanned. File a follow-up issue if violations are suspected there.

The gate is **necessary but not sufficient** for the WCAG 2.1 AA
commitment. It does NOT catch:

- **`:focus-visible` contrast** or any focus-state bug (axe doesn't
  drive keyboard/focus state unless the spec deliberately does). The
  M7g focus-visible regression `e1669e4` would NOT have been caught
  by this gate.
- **Screen-reader announcement** issues.
- **Keyboard-only navigation** defects.
- **Dynamic focus order** problems.

These remain manual M7g audit concerns. Don't mistake a green axe run
for full WCAG-AA conformance.

## Related issues

- #64 - this suite (anonymous flows; v1 gate).
- #65 - cross-browser matrix (post-v1).
- #66 - axe-core a11y assertions (v1 gate; depends on this suite).
- #67 - visual regression (post-v1).
- #68 - signed-in flows (deferred indefinitely; needs a test tenant).
