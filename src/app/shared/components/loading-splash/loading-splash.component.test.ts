import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';
import { LoadingSplashComponent } from './loading-splash.component';

describe('LoadingSplashComponent', () => {
  let fixture: ComponentFixture<LoadingSplashComponent>;
  const kindSignal = signal<'jotjson' | 'blob' | null>(null);
  const progressSignal = signal<number | null>(null);
  const renderPendingSignal = signal<boolean>(false);

  beforeEach(() => {
    kindSignal.set(null);
    progressSignal.set(null);
    renderPendingSignal.set(false);
    const stub: Partial<LoadingSplashService> = {
      kind: kindSignal.asReadonly(),
      progress: progressSignal.asReadonly(),
      renderPending: renderPendingSignal.asReadonly(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LoadingSplashComponent],
      providers: [{ provide: LoadingSplashService, useValue: stub }],
    });
    fixture = TestBed.createComponent(LoadingSplashComponent);
    fixture.detectChanges();
  });

  function splash(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.jot-splash');
  }

  function bar(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.jot-splash__bar');
  }

  function labelText(): string {
    const node = fixture.nativeElement.querySelector('.jot-splash__label');
    return node?.textContent?.trim() ?? '';
  }

  it('renders nothing when kind is null and renderPending is false', () => {
    expect(splash()).toBeNull();
  });

  it('renders the JotJSON splash when kind is "jotjson"', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    expect(labelText()).toBe('Loading JotJSON...');
    expect(bar(), 'bar is visible during the bootstrap stage').not.toBeNull();
  });

  it('renders the blob splash with the "Downloading JSON..." label when kind is "blob"', () => {
    kindSignal.set('blob');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    expect(
      labelText(),
      'label updated from "Loading JSON..." to "Downloading JSON..." for clearer phase semantic',
    ).toBe('Downloading JSON...');
    expect(bar(), 'bar is visible during the download stage').not.toBeNull();
  });

  it('renders the "Rendering tree..." label and HIDES the bar when renderPending is true', () => {
    kindSignal.set(null);
    renderPendingSignal.set(true);
    fixture.detectChanges();
    expect(splash(), 'splash stays visible during the render-pending stage').not.toBeNull();
    expect(labelText()).toBe('Rendering tree...');
    expect(
      bar(),
      'bar is intentionally hidden during render-pending - no honest progress signal to show, and a pinned-at-100% bar reads as stuck',
    ).toBeNull();
  });

  it('renderPending takes precedence over kind for label selection', () => {
    // Defensive: even if kind is somehow non-null while renderPending
    // is true (a state the service should never produce), the label
    // derives from renderPending first.
    kindSignal.set('blob');
    renderPendingSignal.set(true);
    fixture.detectChanges();
    expect(labelText()).toBe('Rendering tree...');
    expect(
      bar(),
      'barVisible = visible && !renderPending; renderPending takes precedence',
    ).toBeNull();
  });

  it('hides the splash when both kind transitions back to null and renderPending stays false', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    kindSignal.set(null);
    fixture.detectChanges();
    expect(splash()).toBeNull();
  });

  it('hides the splash when renderPending transitions from true to false (final hide)', () => {
    renderPendingSignal.set(true);
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    renderPendingSignal.set(false);
    fixture.detectChanges();
    expect(
      splash(),
      'after markBlobRenderComplete the splash should be removed from the DOM',
    ).toBeNull();
  });

  it('exposes role="status" and aria-live="polite" for assistive tech', () => {
    kindSignal.set('blob');
    fixture.detectChanges();
    const element = splash()!;
    expect(element.getAttribute('role')).toBe('status');
    expect(element.getAttribute('aria-live')).toBe('polite');
  });

  it('does NOT set aria-label so the accessible name comes from the visible label', () => {
    kindSignal.set('blob');
    fixture.detectChanges();
    const element = splash()!;
    expect(
      element.hasAttribute('aria-label'),
      'aria-label would override the visible-text accessible name',
    ).toBe(false);
  });

  it('renders the same logo + bar markup the static splash uses (visual continuity)', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.jot-splash__bar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.jot-splash__logo')).not.toBeNull();
  });

  it('keeps the logo present during the render-pending stage even though the bar is hidden', () => {
    renderPendingSignal.set(true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.jot-splash__logo'),
      'logo is the visual anchor during the render-pending stage',
    ).not.toBeNull();
  });

  describe('progress binding', () => {
    it('omits the determinate class when progress is null (indeterminate)', () => {
      kindSignal.set('blob');
      progressSignal.set(null);
      fixture.detectChanges();
      const element = bar()!;
      expect(
        element.classList.contains('jot-splash__bar--determinate'),
        'null progress means indeterminate; sliding-stripe animation stays',
      ).toBe(false);
    });

    it('applies the determinate class and binds --jot-progress when progress is a fraction', () => {
      kindSignal.set('blob');
      progressSignal.set(0.42);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('jot-splash__bar--determinate')).toBe(true);
      // Browsers may serialize the bound CSS variable as either a
      // bare number or with a unit; assert the prefix to keep the
      // test resilient to formatting differences.
      const cssVar = element.style.getPropertyValue('--jot-progress');
      expect(cssVar.trim()).toBe('0.42');
    });

    it('updates --jot-progress as the fraction advances', () => {
      kindSignal.set('blob');
      progressSignal.set(0.1);
      fixture.detectChanges();
      progressSignal.set(0.6);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.style.getPropertyValue('--jot-progress').trim()).toBe('0.6');
    });

    it('flips back to indeterminate when progress resets to null mid-flight', () => {
      kindSignal.set('blob');
      progressSignal.set(0.5);
      fixture.detectChanges();
      expect(bar()!.classList.contains('jot-splash__bar--determinate')).toBe(true);
      progressSignal.set(null);
      fixture.detectChanges();
      expect(bar()!.classList.contains('jot-splash__bar--determinate')).toBe(false);
    });

    it('binds 0 to --jot-progress at the start of a determinate fetch', () => {
      kindSignal.set('blob');
      progressSignal.set(0);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('jot-splash__bar--determinate')).toBe(true);
      expect(element.style.getPropertyValue('--jot-progress').trim()).toBe('0');
    });
  });
});
