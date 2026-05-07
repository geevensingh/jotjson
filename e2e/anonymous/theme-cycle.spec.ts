import { expect, test } from '@playwright/test';

import { assertNoSeriousA11yViolations } from '../util/a11y';

/**
 * Anonymous flow: cycle the theme via the toolbar button on the home page
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
 * The spec lands on `theme-dark` deterministically by clicking the cycle
 * button up to three times, regardless of starting state - this avoids
 * coupling to the default-theme assumption (which can drift over time
 * with preference-default changes).
 */
test('theme cycle persists selection across reload', async ({ page }) => {
  await page.goto('/');

  const themeButton = page.getByRole('button', {
    name: /switch to (dark|light) theme|match system theme/i,
  });
  await expect(themeButton).toBeVisible();

  const body = page.locator('body');

  for (let i = 0; i < 3; i++) {
    const cls = (await body.getAttribute('class')) ?? '';
    if (cls.includes('theme-dark')) break;
    await themeButton.click();
  }
  await expect(body).toHaveClass(/\btheme-dark\b/);

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/\btheme-dark\b/);

  await assertNoSeriousA11yViolations(page);
});
