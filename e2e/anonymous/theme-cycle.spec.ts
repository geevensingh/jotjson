import { expect, test } from '@playwright/test';

import { assertNoSeriousA11yViolations } from '../util/a11y';

/**
 * Anonymous flow: change the theme via the toolbar button on the home page
 * and confirm the selection persists across reload.
 *
 * The /profile page is behind authGuard, so it is not reachable for
 * anonymous users. The toolbar's theme-toggle button is the anonymous
 * user's path to change the theme. The button cycles through
 * light -> dark -> system -> light, driven by `home.component.ts:onToggleTheme`.
 *
 * Validates:
 *  - Toolbar theme button mutates the document.body theme class.
 *  - PreferencesService writes theme-{dark,light,system} to document.body
 *    (src/app/core/preferences/preferences.service.ts).
 *  - localStorage-backed preference round-trip survives reload.
 *  - No serious/critical axe-core violations on the final loaded state
 *    in dark theme. paste-and-reload.spec.ts covers the light-theme case.
 *
 * Determinism (per #143): the spec seeds `theme: 'light'` into
 * localStorage via `addInitScript` so the starting state is fully
 * controlled, then clicks the toggle once (light -> dark) and uses
 * Playwright's auto-retrying `toHaveClass` matcher to wait for the
 * Angular `effect()` in PreferencesService to write the body class.
 *
 * The previous version's read-then-click loop raced against the
 * body-class effect, causing rare CI failures where stale class reads
 * cycled the test past `theme-dark` to a final `theme-light` body. The
 * full `light -> dark -> system -> light` cycle remains covered by
 * `home.component.spec.ts` ("onToggleTheme cycles light -> dark ->
 * system -> light"), so the e2e doesn't need to validate the cycle.
 */
test('theme toggle persists selection across reload', async ({ page }) => {
  // Seed an explicit 'light' theme on first navigation only. The
  // conditional guard ensures `page.reload()` doesn't clobber the
  // user's mid-test 'dark' choice (localStorage already holds the new
  // value at reload time).
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('jotjson.preferences.v1')) {
      window.localStorage.setItem('jotjson.preferences.v1', JSON.stringify({ theme: 'light' }));
    }
  });

  await page.goto('/');

  const themeButton = page.getByRole('button', {
    name: /switch to (dark|light) theme|match system theme/i,
  });
  await expect(themeButton).toBeVisible();

  // Body should start in light theme (from seeded localStorage).
  await expect(page.locator('body')).toHaveClass(/\btheme-light\b/);

  // Single click: light -> dark. The auto-retrying `toHaveClass`
  // matcher waits up to expect.timeout (10s) for the Angular effect
  // to flush the body class.
  await themeButton.click();
  await expect(page.locator('body')).toHaveClass(/\btheme-dark\b/);

  // Reload should preserve the dark selection from localStorage.
  await page.reload();
  await expect(page.locator('body')).toHaveClass(/\btheme-dark\b/);

  // Wait for Monaco to finish loading before running the a11y gate.
  // The lazy-loaded `<jj-json-editor>` shows a `.editor-loading`
  // placeholder until Monaco mounts; axe runs on whatever DOM is
  // present at the moment of the assertion, so without this wait we
  // can race against Monaco-loading and surface a known unrelated
  // contrast violation on the placeholder text in dark mode (#145).
  // Aligns with `e2e/util/a11y.ts`'s documented usage: "Call ...
  // after the DOM has settled".
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });

  await assertNoSeriousA11yViolations(page);
});
