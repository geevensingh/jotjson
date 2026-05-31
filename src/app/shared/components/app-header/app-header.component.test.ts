import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeMsalClient, provideFakeAuth, signInFakeUser } from '../../../../testing/auth.testing';
import { AuthService } from '../../../core/auth/auth.service';
import { AppHeaderComponent } from './app-header.component';

describe('AppHeaderComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  async function create(client?: FakeMsalClient) {
    await TestBed.configureTestingModule({
      imports: [AppHeaderComponent],
      providers: [...provideFakeAuth(client), provideRouter([])],
    }).compileComponents();
    // Force the "configured" branch so the signed-in vs not tests are
    // deterministic across envs (CI overwrites environment.ts with the
    // example variant that has an empty clientId). Must be set BEFORE the
    // component is created because AppHeader captures `isConfigured` into a
    // readonly field during construction.
    const auth = TestBed.inject(AuthService);
    (auth as unknown as { isConfigured: boolean }).isConfigured = true;
    const fixture = TestBed.createComponent(AppHeaderComponent);
    fixture.detectChanges();
    return { fixture, auth };
  }

  it('renders a brand link pointing to the home route', async () => {
    const { fixture } = await create();
    const link = fixture.nativeElement.querySelector('a.brand') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/');
    expect(link.textContent?.trim()).toContain('JotJSON');
  });

  it('renders a sign-in button when configured and not signed in', async () => {
    const { fixture } = await create();
    const btn = fixture.nativeElement.querySelector(
      'button[aria-label="Sign in"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('renders a disabled placeholder when auth is not configured', async () => {
    await TestBed.configureTestingModule({
      imports: [AppHeaderComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    }).compileComponents();
    const auth = TestBed.inject(AuthService);
    (auth as unknown as { isConfigured: boolean }).isConfigured = false;
    const fixture = TestBed.createComponent(AppHeaderComponent);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector(
      'button[aria-label="Sign in (not configured)"]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('renders user display name (linking to /profile) when signed in, with no sign-out button', async () => {
    const { fixture, auth } = await create();
    signInFakeUser(auth, {
      user: { id: 'oid-1', displayName: 'Test User', email: 'user@example.com' },
    });
    fixture.detectChanges();

    const userLink = fixture.nativeElement.querySelector('a.user-name') as HTMLAnchorElement;
    expect(userLink).toBeTruthy();
    expect(userLink.textContent?.trim()).toBe('Test User');
    expect(userLink.getAttribute('href')).toBe('/profile');

    // Sign-out lives on the Profile page, not in the header.
    const signOut = fixture.nativeElement.querySelector('button[aria-label="Sign out"]');
    expect(signOut).toBeNull();

    // Blobs affordance is visible only when signed in.
    const blobsLink = fixture.nativeElement.querySelector(
      'a[aria-label="Your saved blobs"]',
    ) as HTMLAnchorElement;
    expect(blobsLink).toBeTruthy();
    expect(blobsLink.getAttribute('href')).toBe('/blobs');

    // Formatting rules affordance is also signed-in only.
    const rulesLink = fixture.nativeElement.querySelector(
      'a[aria-label="Formatting rules"]',
    ) as HTMLAnchorElement;
    expect(rulesLink).toBeTruthy();
    expect(rulesLink.getAttribute('href')).toBe('/formatting-rules');
  });

  it('does not render the Blobs link when signed out', async () => {
    const { fixture } = await create();
    const blobsLink = fixture.nativeElement.querySelector('a[aria-label="Your saved blobs"]');
    expect(blobsLink).toBeNull();
  });

  it('does not render the Formatting rules link when signed out', async () => {
    const { fixture } = await create();
    const rulesLink = fixture.nativeElement.querySelector('a[aria-label="Formatting rules"]');
    expect(rulesLink).toBeNull();
  });

  it('onSignIn delegates to AuthService', async () => {
    const { fixture, auth } = await create();
    const signInSpy = vi.spyOn(auth, 'signIn');
    fixture.componentInstance.onSignIn();
    expect(signInSpy).toHaveBeenCalledTimes(1);
  });
});
