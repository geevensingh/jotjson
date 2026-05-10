import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Accessibility-smoke helper for the Playwright suite (#66, v1 gate).
 *
 * Runs axe-core against the current page, restricted to WCAG 2 / 2.1
 * Level A and AA rules, and asserts that no `serious` or `critical`
 * violations remain. The gate is necessary but not sufficient for the
 * spec's WCAG 2.1 AA commitment - keyboard-only navigation,
 * screen-reader announcements, dynamic focus order, and `:focus-visible`
 * contrast remain manual M7g audit concerns. See `e2e/README.md` for the
 * full coverage statement.
 *
 * Allow-list discipline:
 *  - `ALLOW_LISTED_RULES` is the single source of truth for known
 *    accepted exceptions. Each entry has a `reviewBy` ISO date.
 *  - The helper validates `reviewBy` dates BEFORE running axe. Any
 *    expired entry fails the test with a clear message, forcing
 *    review rather than letting the allow-list rot.
 *  - Per-spec `options.disableRules` are merged + de-duped with the
 *    global allow-list and passed to `AxeBuilder.disableRules()` in a
 *    single call (the builder's `disableRules()` is NOT cumulative;
 *    later calls overwrite prior calls).
 */

export interface AllowEntry {
  /** axe-core rule id (e.g. `'color-contrast'`). */
  readonly rule: string;
  /** One-line justification for the exception. */
  readonly reason: string;
  /** ISO date (YYYY-MM-DD) when this entry must be re-evaluated. */
  readonly reviewBy: string;
}

/**
 * Allow-list of axe rules to skip across all smoke specs. KEEP THIS
 * SHORT. Each entry must have a `reviewBy` no further out than ~90
 * days from the day it was added; on expiry the helper fails the
 * gate.
 *
 * Add an entry only when:
 *   1. The violation is a known framework limitation (e.g. an Angular
 *      Material 21 component contrast quirk we cannot fix without
 *      forking the component), AND
 *   2. There is no reasonable in-app workaround, AND
 *   3. The reason has been triaged with the team.
 */
export const ALLOW_LISTED_RULES: readonly AllowEntry[] = Object.freeze([]);

/** Options accepted by {@link assertNoSeriousA11yViolations}. */
export interface A11ySmokeOptions {
  /**
   * Spec-local rule disables on top of the global allow-list. Use
   * sparingly with an inline `// reason: ...` comment at the call site.
   */
  readonly disableRules?: readonly string[];
  /** Optional CSS scope. Defaults to whole-page. */
  readonly include?: string;
}

const WCAG_A_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Impact levels that fail the gate. Less severe levels are reported by axe but ignored here. */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertAllowListIsCurrent(today: string): void {
  const expired = ALLOW_LISTED_RULES.filter((entry) => entry.reviewBy < today);
  if (expired.length === 0) return;
  const lines = expired.map(
    (entry) => `  - rule="${entry.rule}" reviewBy=${entry.reviewBy} reason="${entry.reason}"`,
  );
  throw new Error(
    [
      `A11y allow-list has ${expired.length} expired entr${expired.length === 1 ? 'y' : 'ies'} (today=${today}):`,
      ...lines,
      'Re-evaluate each entry: confirm the underlying issue still exists, then either remove the entry (if fixed) or extend `reviewBy` (if the framework limitation persists). See e2e/util/a11y.ts.',
    ].join('\n'),
  );
}

function mergeDisabledRules(perCall: readonly string[] | undefined): string[] {
  const set = new Set<string>(ALLOW_LISTED_RULES.map((entry) => entry.rule));
  for (const rule of perCall ?? []) set.add(rule);
  return [...set];
}

function formatViolations(
  violations: ReadonlyArray<{
    id: string;
    impact?: string | null;
    helpUrl: string;
    nodes: ReadonlyArray<{ target: ReadonlyArray<string> }>;
  }>,
): string {
  const blocks = violations.map((violation) => {
    const targets = violation.nodes
      .slice(0, 3)
      .map((node) => `      - ${node.target.join(' >> ')}`)
      .join('\n');
    const overflow =
      violation.nodes.length > 3 ? `\n      ... and ${violation.nodes.length - 3} more` : '';
    return [
      `  - rule: ${violation.id}`,
      `    impact: ${violation.impact ?? 'unknown'}`,
      `    help: ${violation.helpUrl}`,
      `    nodes (${violation.nodes.length}):`,
      `${targets}${overflow}`,
    ].join('\n');
  });
  return blocks.join('\n');
}

/**
 * Asserts the current page has no `serious` or `critical` axe-core
 * violations across WCAG 2 / 2.1 Level A and AA rule tags.
 *
 * Call at the END of a spec, after the user-flow assertions, and
 * after the DOM has settled (e.g., after the final
 * `expect(locator).toBeVisible()` in the spec). Do not use
 * `waitForLoadState('networkidle')` as a readiness signal.
 */
export async function assertNoSeriousA11yViolations(
  page: Page,
  options: A11ySmokeOptions = {},
): Promise<void> {
  assertAllowListIsCurrent(todayIsoDate());

  const disabledRules = mergeDisabledRules(options.disableRules);

  let builder = new AxeBuilder({ page }).withTags(WCAG_A_AA_TAGS);
  if (disabledRules.length > 0) {
    builder = builder.disableRules(disabledRules);
  }
  if (options.include) {
    builder = builder.include(options.include);
  }

  const results = await builder.analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact != null && BLOCKING_IMPACTS.has(violation.impact),
  );

  expect(
    blocking,
    blocking.length === 0
      ? 'no serious or critical a11y violations'
      : `Expected no serious/critical a11y violations, found ${blocking.length}:\n${formatViolations(blocking)}`,
  ).toEqual([]);
}
