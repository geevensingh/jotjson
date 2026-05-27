import type { ComponentFixture } from '@angular/core/testing';
import axe, { type AxeResults, type ImpactValue, type NodeResult, type Result } from 'axe-core';

/**
 * The strict-gate impact bar for M7g (per `DESIGN_SPEC.md` -> Accessibility).
 * `moderate` and `minor` violations are surfaced as console warnings and
 * filed as `priority:medium` follow-ups; they do not fail the suite.
 */
const STRICT_IMPACTS: ReadonlyArray<ImpactValue> = ['critical', 'serious'];

/**
 * WCAG 2.1 AA tags. We deliberately exclude `best-practice` and WCAG 2.2
 * tags; they are advisory only per the audit scope.
 */
const WCAG_AA_TAGS: ReadonlyArray<string> = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Settle Angular change detection plus two animation frames before scanning,
 * so layout-dependent rules (contrast, target size) and Material overlay
 * positioning have stabilised. Two frames is a deliberate buffer: one frame
 * to commit any deferred styles, one frame for the OverlayContainer's first
 * paint cycle.
 */
async function settle(
  fixture: ComponentFixture<unknown>,
  options: { skipWhenStable?: boolean } = {},
): Promise<void> {
  fixture.detectChanges();
  if (!options.skipWhenStable) {
    await fixture.whenStable();
  }
  fixture.detectChanges();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Mount a fixture's host element into `document.body` so the rendered tree
 * is in the live document. Required for:
 *   - layout-dependent axe rules (contrast, target size, reflow);
 *   - Angular Material overlays (`MatMenu`, `MatDialog`, snackbars) that
 *     render under `document.body` via the CDK `OverlayContainer`;
 *   - any `:focus-visible` / focus-trap behaviour that depends on the host
 *     being in the live document.
 *
 * The fixture's host is wrapped in a clearly-marked container so cleanup
 * can remove the right node even if the fixture is destroyed first.
 *
 * Body state is also snapshot here and restored on teardown. Other specs
 * may leave `<body>` with stray classes (notably `theme-light` /
 * `theme-system` injected by `PreferencesService`); those make contrast
 * checks non-deterministic across spec ordering. The wrapper also forces a
 * known-good theme class for the duration of the scan.
 */
function mountFixtureHost(
  fixture: ComponentFixture<unknown>,
  theme: 'dark' | 'light',
): { wrapper: HTMLDivElement; restore: () => void } {
  const previousClassName = document.body.className;
  const previousStyleCss = document.body.style.cssText;

  document.body.classList.remove('theme-dark', 'theme-light', 'theme-system');
  document.body.classList.add(`theme-${theme}`);

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-jj-a11y-fixture', '');
  // Wrapper inline-style is load-bearing for axe-core color-contrast (issue #142).
  // - background-color terminates axe's bg-walk at the wrapper instead of letting
  //   axe sort body to the end of the stack (axe.js sortPageBackground) and
  //   resolve to a sibling like .jasmine_html-reporter (#eee from jasmine.css).
  //   Use var(--bg) so the wrapper paints what body would in production; #1e1e1e
  //   fallback defends against future cascade refactors that might break the --bg
  //   cascade in tests.
  // - isolation: isolate creates a stacking context so the wrapper's contents are
  //   visually-sorted independently of body siblings -- defensive against any
  //   future Karma/Jasmine chrome the runner might inject as a body sibling.
  wrapper.style.cssText =
    'position: relative; width: 100%; min-height: 100vh; ' +
    'background-color: var(--bg, #1e1e1e); isolation: isolate;';
  wrapper.appendChild(fixture.nativeElement);
  document.body.appendChild(wrapper);

  const restore = (): void => {
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    document.body.className = previousClassName;
    document.body.style.cssText = previousStyleCss;
  };
  return { wrapper, restore };
}

interface RunAxeOptions {
  /**
   * Element to scan. Defaults to the fixture's `nativeElement` so the scan
   * is naturally scoped to the component under test and does not pick up
   * Karma / Jasmine reporter chrome rendered elsewhere in `document.body`.
   *
   * For specs that exercise Material overlays (`MatMenu`, `MatDialog`,
   * snackbars), pass `target: document.body` so the CDK
   * `cdk-overlay-container` (which renders as a sibling of the fixture
   * wrapper) is included. Overlay specs typically also pass an `exclude`
   * list to filter out Karma/Jasmine UI -- see the `OVERLAY_EXCLUDES`
   * convenience export.
   */
  target?: Element;
  /**
   * Selectors to exclude from the scan. Useful for third-party widgets
   * whose internal a11y is tracked upstream (e.g., the Monaco editor's
   * `.monaco-editor` subtree) and for the Karma/Jasmine reporter chrome
   * that lives in `document.body` alongside the fixture wrapper.
   */
  exclude?: string[];
  /**
   * Skip `await fixture.whenStable()` during settle. Required for
   * components that hold a long-running zone task (e.g., a `setInterval`
   * tick) which prevents Angular's stability promise from ever
   * resolving; the json-tree component is the canonical example -- it
   * runs a `NOW_TICK_MS` `setInterval` to power "saved 3s ago"-style
   * timestamps, so `whenStable()` never resolves under it. Two
   * `requestAnimationFrame` waits still run, which is sufficient for
   * layout to settle before axe scans.
   */
  skipWhenStable?: boolean;
}

/**
 * Selectors that filter Karma + Jasmine + Angular debug UI out of an
 * overlay-state scan. Intended for callers that pass `target:
 * document.body` to capture the CDK overlay container.
 */
export const OVERLAY_EXCLUDES: ReadonlyArray<string> = [
  '.jasmine_html-reporter',
  '.jasmine-overall-result',
  '.jasmine-banner',
  '.jasmine-runner',
  '.jasmine-symbol-summary',
  '.jasmine-alert',
  '.jasmine-results',
  '.jasmine-suite',
  '.jasmine-spec',
  '#karma-context',
  'div[id^="karma"]',
];

export function getOverlayContainerElement(): HTMLElement {
  const overlayContainer = document.querySelector<HTMLElement>('.cdk-overlay-container');
  expect(overlayContainer, 'expected CDK overlay container').not.toBeNull();
  if (!overlayContainer) {
    throw new Error('Expected CDK overlay container.');
  }
  return overlayContainer;
}

/**
 * Run axe-core against an attached DOM with WCAG 2.1 A/AA tags.
 *
 * Returns the full `AxeResults` so callers can choose how to react. The
 * `assertNoStrictA11yViolations` helper is the canonical strict gate; it
 * filters to `critical` + `serious` impact and asserts the resulting list
 * is empty with a readable failure message.
 */
export async function runA11yScan(
  fixture: ComponentFixture<unknown>,
  options: RunAxeOptions = {},
): Promise<AxeResults> {
  await settle(fixture, { skipWhenStable: options.skipWhenStable });

  const target = options.target ?? (fixture.nativeElement as Element);
  const context: axe.ElementContext =
    options.exclude && options.exclude.length > 0
      ? { include: [target], exclude: options.exclude.map((selector) => [selector]) }
      : target;

  return axe.run(context, {
    runOnly: { type: 'tag', values: [...WCAG_AA_TAGS] },
    resultTypes: ['violations', 'incomplete'],
  });
}

/**
 * Format an axe violation list as a multi-line string suitable for a
 * test-runner `expect.fail()` message. Each violation includes the rule id, impact,
 * help URL, and the first few offending node selectors.
 */
function formatViolations(violations: ReadonlyArray<Result>): string {
  if (violations.length === 0) return '';
  const lines: string[] = [];
  for (const violation of violations) {
    lines.push(
      `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help} (${violation.helpUrl})`,
    );
    const nodes = violation.nodes.slice(0, 5);
    for (const node of nodes) {
      lines.push(`    -> ${formatNodeTarget(node)}`);
      if (node.failureSummary) {
        const summary = node.failureSummary.replace(/\n/g, ' ');
        lines.push(`       ${summary}`);
      }
    }
    if (violation.nodes.length > nodes.length) {
      lines.push(`    -> ... and ${violation.nodes.length - nodes.length} more node(s)`);
    }
  }
  return lines.join('\n');
}

function formatNodeTarget(node: NodeResult): string {
  if (!node.target || node.target.length === 0) return '(no selector)';
  return node.target
    .map((selector) => (Array.isArray(selector) ? selector.join(' ') : selector))
    .join(', ');
}

/**
 * Strict-gate assertion: fail the spec if any `critical` or `serious`
 * violation is present. Lower-impact violations are emitted as
 * `console.warn` so they remain visible during development without
 * breaking the build.
 *
 * Always registers a Jasmine expectation, even on the success path, so
 * specs are never flagged as expectation-less.
 */
export function assertNoStrictA11yViolations(results: AxeResults): void {
  const strict = results.violations.filter(
    (violation) => violation.impact !== undefined && STRICT_IMPACTS.includes(violation.impact),
  );
  const advisory = results.violations.filter(
    (violation) => violation.impact === undefined || !STRICT_IMPACTS.includes(violation.impact),
  );

  if (advisory.length > 0) {
    console.warn(
      `[a11y] ${advisory.length} advisory violation(s) (moderate/minor) -- file as priority:medium follow-ups:\n${formatViolations(
        advisory,
      )}`,
    );
  }

  const message =
    strict.length === 0
      ? 'No critical or serious WCAG 2.1 AA violations'
      : `Accessibility (WCAG 2.1 AA) check failed with ${strict.length} ` +
        `critical/serious violation(s):\n${formatViolations(strict)}`;
  expect(strict.length, message).toBe(0);
}

/**
 * Convenience: run a scan and immediately assert the strict gate. Most
 * a11y specs need only this call.
 */
export async function expectNoStrictA11yViolations(
  fixture: ComponentFixture<unknown>,
  options: RunAxeOptions = {},
): Promise<void> {
  const results = await runA11yScan(fixture, options);
  assertNoStrictA11yViolations(results);
}

/**
 * Mount a fixture into `document.body`, returning a teardown function that
 * destroys the fixture, removes its wrapper, and restores any prior
 * `<body>` state that the harness mutated (notably theme classes). Use the
 * returned teardown in `afterEach` so suites do not leak host nodes,
 * stale overlays, or theme contamination into subsequent specs.
 *
 * The optional `theme` argument selects the theme class applied to
 * `<body>` for the duration of the scan. Defaults to `'dark'` (the app's
 * default theme). Pass `'light'` to scan a route under the light theme;
 * routes whose appearance is theme-sensitive should have separate specs
 * for each theme.
 *
 * Typical usage:
 *
 *   let teardown: (() => void) | undefined;
 *   afterEach(() => teardown?.());
 *
 *   it('has no critical or serious WCAG 2.1 AA violations', async () => {
 *     const fixture = TestBed.createComponent(MyComponent);
 *     teardown = attachFixtureToBody(fixture);
 *     await expectNoStrictA11yViolations(fixture);
 *   });
 */
export function attachFixtureToBody(
  fixture: ComponentFixture<unknown>,
  theme: 'dark' | 'light' = 'dark',
): () => void {
  const { restore } = mountFixtureHost(fixture, theme);
  return () => {
    try {
      fixture.destroy();
    } catch {
      /* noop -- destroying twice is fine; we still want to remove the wrapper */
    }
    restore();
  };
}
