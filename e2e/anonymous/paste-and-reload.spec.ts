import { expect, test } from '@playwright/test';

/**
 * Anonymous flow: insert JSON into the Monaco editor, see it render in the
 * tree pane, reload the page, and confirm the draft persists.
 *
 * Validates:
 *  - Production bundle boots and Monaco loads in a real browser.
 *  - Editor input -> tree render pipeline.
 *  - localStorage-backed draft persistence across page reload.
 *
 * Does NOT use the toolbar Paste button, which depends on
 * navigator.clipboard.readText() (a known browser-permission flake source).
 * Inserting text directly via Monaco's input area exercises the same
 * editor -> tree contract without the clipboard plumbing.
 *
 * Selectors:
 *  - Monaco's input area is exposed as `role="textbox"` with the
 *    accessible name "JSON editor"; Monaco also renders an aria-hidden
 *    `.ime-text-area` textarea, so role-based selection is more robust
 *    than `.monaco-editor textarea`.
 *  - The tree pane is `<section aria-label="Tree view">`, set in
 *    `src/app/features/home/home.component.html`.
 */
test('paste-and-reload persists draft via localStorage', async ({ page }) => {
  await page.goto('/');

  const editor = page.getByRole('textbox', { name: 'JSON editor' });
  await expect(editor).toBeVisible();
  await editor.focus();

  const payload = '{"hello":"world","count":42}';
  await page.keyboard.insertText(payload);

  const treePane = page.locator('section[aria-label="Tree view"]');
  await expect(treePane).toContainText('hello');
  await expect(treePane).toContainText('world');

  await page.reload();

  await expect(page.getByRole('textbox', { name: 'JSON editor' })).toBeVisible();
  await expect(treePane).toContainText('hello');
  await expect(treePane).toContainText('world');
});
