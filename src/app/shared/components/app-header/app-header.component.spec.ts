import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppHeaderComponent } from './app-header.component';
import { AuthService } from '../../../core/auth/auth.service';
import { AuthUser } from '../../../core/auth/auth-user';
import { FakeMsalClient, provideFakeAuth } from '../../../../testing/auth.testing';

describe('AppHeaderComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  async function create(client?: FakeMsalClient) {
    await TestBed.configureTestingModule({
      imports: [AppHeaderComponent],
      providers: [...provideFakeAuth(client), provideRouter([])]
    }).compileComponents();
    const fixture = TestBed.createComponent(AppHeaderComponent);
    fixture.detectChanges();
    return { fixture, auth: TestBed.inject(AuthService) };
  }

  it('renders a brand link pointing to the home route', async () => {
    const { fixture } = await create();
    const link = fixture.nativeElement.querySelector('a.brand') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent?.trim()).toContain('JotJSON');
  });

  it('renders a sign-in button when configured and not signed in', async () => {
    const { fixture, auth } = await create();
    if (!auth.isConfigured) {
      // Environment without a clientId: the "not configured" branch renders
      // a disabled sign-in button instead.
      const btn = fixture.nativeElement.querySelector(
        'button[aria-label="Sign in (not configured)"]'
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(true);
      return;
    }
    const btn = fixture.nativeElement.querySelector(
      'button[aria-label="Sign in"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('renders user display name (linking to /profile) when signed in, with no sign-out button', async () => {
    const { fixture, auth } = await create();
    if (!auth.isConfigured) {
      return;
    }
    // Simulate a signed-in user via the AuthService internal signal.
    const authAny = auth as unknown as {
      userSignal: { set(v: AuthUser | null): void };
    };
    authAny.userSignal.set({
      id: 'oid-1',
      displayName: 'Test User',
      email: 'user@example.com'
    });
    fixture.detectChanges();

    const userLink = fixture.nativeElement.querySelector('a.user-name') as HTMLAnchorElement;
    expect(userLink).toBeTruthy();
    expect(userLink.textContent?.trim()).toBe('Test User');
    expect(userLink.getAttribute('href')).toBe('/profile');

    // Sign-out lives on the Profile page, not in the header.
    const signOut = fixture.nativeElement.querySelector('button[aria-label="Sign out"]');
    expect(signOut).toBeNull();

    // History affordance is visible only when signed in.
    const historyLink = fixture.nativeElement.querySelector(
      'a[aria-label="Your saved blobs"]'
    ) as HTMLAnchorElement;
    expect(historyLink).toBeTruthy();
    expect(historyLink.getAttribute('href')).toBe('/history');
  });

  it('does not render the history link when signed out', async () => {
    const { fixture } = await create();
    const historyLink = fixture.nativeElement.querySelector(
      'a[aria-label="Your saved blobs"]'
    );
    expect(historyLink).toBeNull();
  });

  it('onSignIn delegates to AuthService', async () => {
    const { fixture, auth } = await create();
    const signInSpy = spyOn(auth, 'signIn');
    fixture.componentInstance.onSignIn();
    expect(signInSpy).toHaveBeenCalledTimes(1);
  });
});
