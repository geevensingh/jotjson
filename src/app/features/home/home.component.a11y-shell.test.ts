import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideFakeAuth } from '../../../testing/auth.testing';
import {
  installMinimalMonacoStub,
  pinMinimalMonacoLoaderForFile,
  restoreMonacoStub,
} from '../../../testing/monaco.testing';
import { HomeComponent } from './home.component';

// Issue #513 - see the matching note in `home.component.test.ts`. This
// spec never destroys its fixtures, so a late `JsonEditorComponent`
// lifecycle could reach `loadMonaco()` after `restoreMonacoStub()`.
pinMinimalMonacoLoaderForFile();

/**
 * Lightweight DOM-pattern shell spec for the home route. The full axe scan
 * against this route is deferred to Wave 3c (Monaco), which needs the real
 * Monaco DOM surface to give meaningful results. In the meantime, this
 * spec is the regression gate for the M7g-3a app-shell foundations: every
 * route must expose a `<main id="main-content">` landmark and an `<h1>`
 * for screen-reader page identification.
 */
describe('HomeComponent (a11y shell landmarks)', () => {
  beforeEach(() => {
    installMinimalMonacoStub();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([]), provideNoopAnimations()],
    });
  });

  afterEach(() => {
    restoreMonacoStub();
  });

  it('renders <main id="main-content"> as a focusable landmark', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('main#main-content') as HTMLElement | null;
    expect(
      main,
      'home route must expose <main id="main-content"> for the skip-link target',
    ).not.toBeNull();
    expect(
      main?.getAttribute('tabindex'),
      'non-interactive <main> needs tabindex="-1" so RouteFocusService can focus it',
    ).toBe('-1');
  });

  it('renders an <h1> inside <main> for screen-reader page identification', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector(
      'main#main-content h1',
    ) as HTMLElement | null;
    expect(
      heading,
      'every route should have exactly one top-level heading inside <main>',
    ).not.toBeNull();
    expect(
      heading?.textContent?.trim().length,
      'the <h1> must have non-empty content (visually-hidden via .sr-only is fine)',
    ).toBeGreaterThan(0);
  });
});
