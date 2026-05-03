import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';
import { LoadingSplashComponent } from './loading-splash.component';

describe('LoadingSplashComponent', () => {
  let fixture: ComponentFixture<LoadingSplashComponent>;
  const kindSignal = signal<'jotjson' | 'blob' | null>(null);

  beforeEach(() => {
    kindSignal.set(null);
    const stub: Partial<LoadingSplashService> = {
      kind: kindSignal.asReadonly(),
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
});
