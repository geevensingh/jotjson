import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';
import { LoadingSplashComponent } from './loading-splash.component';

describe('LoadingSplashComponent', () => {
  let fixture: ComponentFixture<LoadingSplashComponent>;
  const kindSignal = signal<'jotjson' | 'blob' | null>(null);
  const progressSignal = signal<number | null>(null);

  beforeEach(() => {
    kindSignal.set(null);
    progressSignal.set(null);
    const stub: Partial<LoadingSplashService> = {
      kind: kindSignal.asReadonly(),
      progress: progressSignal.asReadonly(),
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

  it('renders nothing when kind is null', () => {
    expect(splash()).toBeNull();
  });

  it('renders the JotJSON splash when kind is "jotjson"', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    expect(labelText()).toBe('Loading JotJSON...');
  });

  it('renders the blob splash with the "Loading JSON..." label when kind is "blob"', () => {
    kindSignal.set('blob');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    expect(labelText()).toBe('Loading JSON...');
  });

  it('hides the splash when kind transitions back to null', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(splash()).not.toBeNull();
    kindSignal.set(null);
    fixture.detectChanges();
    expect(splash()).toBeNull();
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
    expect(element.hasAttribute('aria-label'))
      .withContext('aria-label would override the visible-text accessible name')
      .toBeFalse();
  });

  it('renders the same logo + bar markup the static splash uses (visual continuity)', () => {
    kindSignal.set('jotjson');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.jot-splash__bar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.jot-splash__logo')).not.toBeNull();
  });

  describe('progress binding', () => {
    it('omits the determinate class when progress is null (indeterminate)', () => {
      kindSignal.set('blob');
      progressSignal.set(null);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('jot-splash__bar--determinate'))
        .withContext('null progress means indeterminate; sliding-stripe animation stays')
        .toBeFalse();
    });

    it('applies the determinate class and binds --jot-progress when progress is a fraction', () => {
      kindSignal.set('blob');
      progressSignal.set(0.42);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('jot-splash__bar--determinate')).toBeTrue();
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
      expect(bar()!.classList.contains('jot-splash__bar--determinate')).toBeTrue();
      progressSignal.set(null);
      fixture.detectChanges();
      expect(bar()!.classList.contains('jot-splash__bar--determinate')).toBeFalse();
    });

    it('binds 0 to --jot-progress at the start of a determinate fetch', () => {
      kindSignal.set('blob');
      progressSignal.set(0);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('jot-splash__bar--determinate')).toBeTrue();
      expect(element.style.getPropertyValue('--jot-progress').trim()).toBe('0');
    });
  });
});
