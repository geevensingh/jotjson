import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { AuthUser } from '../../core/auth/auth-user';
import { AuthService } from '../../core/auth/auth.service';
import { ProfileComponent } from './profile.component';

/**
 * Wave 3a (M7g-3a) shell-landmark spec for the /profile route.
 * Full axe scan deferred to a later fix wave (the route uses
 * `<mat-form-field>` which has its own contrast considerations).
 */
describe('ProfileComponent (a11y shell landmarks)', () => {
  function configure(user: AuthUser | null): void {
    const userSignal = signal<AuthUser | null>(user);
    const authStub = {
      user: userSignal.asReadonly(),
      isSignedIn: (() => userSignal() !== null) as unknown as AuthService['isSignedIn'],
      isConfigured: true,
      signIn: vi.fn(),
      signOut: vi.fn(),
    } as unknown as AuthService;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        ...provideFakeAuth(),
        { provide: AuthService, useValue: authStub },
      ],
    });
  }

  it('renders <main id="main-content"> with tabindex="-1" when signed in', () => {
    configure({ id: 'u1', displayName: 'Sample User', email: 'sample@example.com' });
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const main = fixture.nativeElement.querySelector('main#main-content') as HTMLElement | null;
    expect(
      main,
      'every route must expose <main id="main-content"> for the app-header skip-link',
    ).not.toBeNull();
    expect(
      main?.getAttribute('tabindex'),
      'non-interactive <main> needs tabindex="-1" so RouteFocusService can focus it',
    ).toBe('-1');
  });

  it('renders an <h1> inside <main> for screen-reader page identification', () => {
    configure({ id: 'u1', displayName: 'Sample User', email: 'sample@example.com' });
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector(
      'main#main-content h1',
    ) as HTMLElement | null;
    expect(
      heading,
      'every route should expose a top-level <h1> for SR page identification',
    ).not.toBeNull();
    expect(
      heading?.textContent?.trim().length,
      'the <h1> must have non-empty content',
    ).toBeGreaterThan(0);
  });
});
