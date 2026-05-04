import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { NotFoundComponent } from './not-found.component';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { attachFixtureToBody, expectNoStrictA11yViolations } from '../../../testing/a11y';

/**
 * Strict-gate accessibility spec for the simplest route in the app. Acts as
 * the canary for the M7g `*.a11y.spec.ts` pattern: no allowlists, no
 * `xit`-skipped cases. If this spec ever needs an allowlist to stay green,
 * the underlying violation must be fixed instead.
 *
 * Scope: critical + serious WCAG 2.1 AA violations against the rendered
 * component live in `document.body`. Lower-impact violations are surfaced
 * as console warnings only (see `src/testing/a11y.ts`).
 */
describe('NotFoundComponent (a11y)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [NotFoundComponent],
      providers: [provideRouter([]), provideNoopAnimations(), ...provideFakeAuth()],
    }).compileComponents();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    try {
      history.replaceState(null, '', location.href);
    } catch {
      /* noop */
    }
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('has no critical or serious WCAG 2.1 AA violations in the generic state', async () => {
    const fixture = TestBed.createComponent(NotFoundComponent);
    teardown = attachFixtureToBody(fixture);
    await expectNoStrictA11yViolations(fixture);
  });

  it('has no critical or serious WCAG 2.1 AA violations in the blob-not-found state', async () => {
    history.replaceState({ attemptedSlug: 'abc123' }, '', location.href);
    const fixture = TestBed.createComponent(NotFoundComponent);
    teardown = attachFixtureToBody(fixture);
    await expectNoStrictA11yViolations(fixture);
  });
});
