import type { Page } from '@playwright/test';

/**
 * Asserts the visible JSON tree has actually expanded after an
 * `expand-all` click. Used by L3 perf scenarios to catch silent
 * expand-all failures (e.g., toolbar button moved, keybinding broken)
 * before recording timings against an unexpanded tree.
 *
 * Checks:
 *   - At least `minExpandedNodes` interior nodes carry
 *     `[aria-expanded="true"]`.
 *   - At least `minVisibleTreeItems` `[role="treeitem"]` elements are
 *     mounted in the tree pane.
 *
 * Polls for up to `timeoutMs` (default 5000) to absorb layout-commit
 * jitter; throws a clear "expand-all postcondition failed" error on
 * shortfall.
 *
 * @param page Playwright page handle.
 * @param expected Thresholds. Both are optional but at least one must be set.
 */
export async function assertExpandedTree(
  page: Page,
  expected: {
    minExpandedNodes?: number;
    minVisibleTreeItems?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = expected.timeoutMs ?? 5000;
  const minExpandedNodes = expected.minExpandedNodes ?? 0;
  const minVisibleTreeItems = expected.minVisibleTreeItems ?? 0;
  if (minExpandedNodes === 0 && minVisibleTreeItems === 0) {
    throw new Error(
      'assertExpandedTree: at least one of minExpandedNodes / minVisibleTreeItems must be > 0',
    );
  }
  const deadline = Date.now() + timeoutMs;
  let lastExpanded = -1;
  let lastVisible = -1;
  while (Date.now() < deadline) {
    lastExpanded = await page
      .locator('section[aria-label="Tree view"] [role="treeitem"][aria-expanded="true"]')
      .count();
    lastVisible = await page.locator('section[aria-label="Tree view"] [role="treeitem"]').count();
    if (lastExpanded >= minExpandedNodes && lastVisible >= minVisibleTreeItems) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reasons: string[] = [];
  if (lastVisible < minVisibleTreeItems) {
    reasons.push(`visible tree items: expected >= ${minVisibleTreeItems}, got ${lastVisible}`);
  }
  if (lastExpanded < minExpandedNodes) {
    reasons.push(`expanded nodes: expected >= ${minExpandedNodes}, got ${lastExpanded}`);
  }
  throw new Error(
    `expand-all postcondition failed: ${reasons.join('; ')} (timeout ${timeoutMs}ms)`,
  );
}
