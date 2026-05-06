import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { AppHeaderComponent } from './app-header.component';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../../../../testing/a11y';

/**
 * Strict-gate accessibility spec for the persistent app header.
 *
 * Covers two M7g-3a deliverables:
 *  - F1.3: a "Skip to main content" link that is hidden by default and
 *    pops to the top of the viewport when it receives keyboard focus.
 *  - F1.5: a `<nav aria-label="Primary">` landmark wrapping the auth-side
 *    route links.
 *
 * Plus the M7g-3g focus-indicator regression for the user-name link
 * (F5.1) and a clean axe scan against the rendered component in both
 * themes. The header is shared by every route, so a regression here
 * would surface on every page.
 */
describe('AppHeaderComponent (a11y)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AppHeaderComponent],
      providers: [provideRouter([]), provideNoopAnimations(), ...provideFakeAuth()],
    }).compileComponents();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('renders a skip-link as the first focusable element', () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const skipLink = host.querySelector('a.skip-link') as HTMLAnchorElement | null;
    expect(skipLink)
      .withContext('app-header should expose a `.skip-link` anchor for keyboard users')
      .not.toBeNull();
    expect(skipLink?.getAttribute('href'))
      .withContext('skip-link should target the main content landmark id')
      .toBe('#main-content');

    const allFocusable = Array.from(
      host.querySelectorAll('a, button:not([disabled])'),
    ) as HTMLElement[];
    expect(allFocusable[0])
      .withContext('skip-link must be the first focusable element so a single Tab reaches it')
      .toBe(skipLink as HTMLElement);
  });

  it('skip-link is visually hidden until it receives focus', () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    const skipLink = fixture.nativeElement.querySelector('a.skip-link') as HTMLElement;
    const idle = getComputedStyle(skipLink);
    expect(idle.position)
      .withContext('skip-link uses position:absolute + clip-rect to stay visually hidden')
      .toBe('absolute');
    expect(idle.clip)
      .withContext('skip-link is clipped to a 0x0 rect when not focused')
      .toBe('rect(0px, 0px, 0px, 0px)');

    skipLink.focus();
    const focused = getComputedStyle(skipLink);
    expect(focused.position)
      .withContext(
        'skip-link should switch to position:fixed when focused so it pops above content',
      )
      .toBe('fixed');
    expect(focused.clip)
      .withContext('skip-link should drop the clip-rect when focused so its text is visible')
      .not.toBe('rect(0px, 0px, 0px, 0px)');
  });

  it('wraps auth-side route links in a primary <nav> landmark', () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const nav = host.querySelector('nav.auth') as HTMLElement | null;
    expect(nav)
      .withContext('app-header should expose a <nav> landmark for the auth-side route links')
      .not.toBeNull();
    expect(nav?.getAttribute('aria-label'))
      .withContext('the primary nav landmark needs an explicit accessible name')
      .toBe('Primary');
  });

  it('user-name link declares a non-text focus indicator on :focus-visible (F5.1)', () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture);
    fixture.detectChanges();

    // The merged `&:hover, &:focus-visible` block on `.user-name` resets
    // `outline: none`, so the focus boundary depends on a separate
    // `&:focus-visible { box-shadow: ... }` rule. Probe the cascaded
    // stylesheets directly rather than relying on `:focus-visible`
    // matching from a programmatic `.focus()` call - that path is
    // gated too aggressively in headless Chrome to be reliable, per the
    // existing `.skip-link` comment in this component's SCSS.
    const matchingRules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        const text = rule.cssText;
        if (
          text.includes('.user-name') &&
          text.includes(':focus-visible') &&
          text.includes('box-shadow')
        ) {
          matchingRules.push(text);
        }
      }
    }
    expect(matchingRules.length)
      .withContext(
        '`.user-name:focus-visible` must declare a `box-shadow` indicator so the focus boundary meets WCAG 2.4.7 / 1.4.11 (F5.1)',
      )
      .toBeGreaterThan(0);
  });

  it('has no critical or serious WCAG 2.1 AA violations (dark theme)', async () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture, 'dark');
    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations (light theme)', async () => {
    const fixture = TestBed.createComponent(AppHeaderComponent);
    teardown = attachFixtureToBody(fixture, 'light');
    await expectNoStrictA11yViolations(fixture);
  });
});
