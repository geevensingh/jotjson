import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';
import { NavigationProgressService } from '../../../core/navigation/navigation-progress.service';
import { RouteProgressBarComponent } from './route-progress-bar.component';

describe('RouteProgressBarComponent', () => {
  let fixture: ComponentFixture<RouteProgressBarComponent>;
  const pendingSignal = signal(false);
  const splashKindSignal = signal<'jotjson' | 'blob' | null>(null);
  const splashProgressSignal = signal<number | null>(null);

  beforeEach(() => {
    pendingSignal.set(false);
    splashKindSignal.set(null);
    splashProgressSignal.set(null);
    const progressStub: Partial<NavigationProgressService> = {
      pending: pendingSignal.asReadonly(),
    };
    const splashStub: Partial<LoadingSplashService> = {
      kind: splashKindSignal.asReadonly(),
      progress: splashProgressSignal.asReadonly(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RouteProgressBarComponent],
      providers: [
        { provide: NavigationProgressService, useValue: progressStub },
        { provide: LoadingSplashService, useValue: splashStub },
      ],
    });
    fixture = TestBed.createComponent(RouteProgressBarComponent);
    fixture.detectChanges();
  });

  function bar(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.route-progress-bar');
  }

  it('does not render the bar when pending() is false', () => {
    expect(bar()).toBeNull();
  });

  it('renders the bar when pending() flips to true', () => {
    pendingSignal.set(true);
    fixture.detectChanges();
    const element = bar();
    expect(element).not.toBeNull();
    expect(
      element!.getAttribute('aria-hidden'),
      'bar is decorative; route change announces the navigation',
    ).toBe('true');
  });

  it('removes the bar when pending() flips back to false', () => {
    pendingSignal.set(true);
    fixture.detectChanges();
    expect(bar()).not.toBeNull();
    pendingSignal.set(false);
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('renders both indeterminate stripes when shown (primary + secondary)', () => {
    pendingSignal.set(true);
    fixture.detectChanges();
    const stripes = fixture.nativeElement.querySelectorAll(
      '.route-progress-bar__stripe',
    ) as NodeListOf<HTMLElement>;
    expect(stripes.length).toBe(2);
    expect(stripes[0]!.classList.contains('route-progress-bar__stripe--primary')).toBe(true);
    expect(stripes[1]!.classList.contains('route-progress-bar__stripe--secondary')).toBe(true);
  });

  it('suppresses the bar while the loading splash is visible (jotjson kind)', () => {
    pendingSignal.set(true);
    splashKindSignal.set('jotjson');
    fixture.detectChanges();
    expect(bar(), 'splash already shows its own bar; stacking would double-render').toBeNull();
  });

  it('suppresses the bar during a blob splash too', () => {
    pendingSignal.set(true);
    splashKindSignal.set('blob');
    fixture.detectChanges();
    expect(bar()).toBeNull();
  });

  it('shows the bar once the splash latches to null (post first-nav)', () => {
    pendingSignal.set(true);
    splashKindSignal.set('jotjson');
    fixture.detectChanges();
    expect(bar()).toBeNull();
    splashKindSignal.set(null);
    fixture.detectChanges();
    expect(bar()).not.toBeNull();
  });

  describe('determinate variant', () => {
    it('stays indeterminate when splash.progress is null', () => {
      pendingSignal.set(true);
      splashProgressSignal.set(null);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('route-progress-bar--determinate')).toBe(false);
    });

    it('flips to determinate and binds --jot-progress when splash.progress is a fraction', () => {
      pendingSignal.set(true);
      splashProgressSignal.set(0.33);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.classList.contains('route-progress-bar--determinate')).toBe(true);
      expect(element.style.getPropertyValue('--jot-progress').trim()).toBe('0.33');
    });

    it('updates the CSS variable as progress advances', () => {
      pendingSignal.set(true);
      splashProgressSignal.set(0.2);
      fixture.detectChanges();
      splashProgressSignal.set(0.85);
      fixture.detectChanges();
      const element = bar()!;
      expect(element.style.getPropertyValue('--jot-progress').trim()).toBe('0.85');
    });

    it('renders the determinate fill element under the determinate class', () => {
      pendingSignal.set(true);
      splashProgressSignal.set(0.5);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.route-progress-bar__fill')).not.toBeNull();
    });
  });
});
