import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProfileComponent } from './profile.component';
import { AuthService } from '../../core/auth/auth.service';
import { AuthUser } from '../../core/auth/auth-user';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { signal } from '@angular/core';

describe('ProfileComponent', () => {
  async function create(overrides?: {
    user?: AuthUser | null;
    isConfigured?: boolean;
  }) {
    const userSignal = signal<AuthUser | null>(overrides?.user ?? null);
    const authStub = {
      user: userSignal.asReadonly(),
      isSignedIn: (() => userSignal() !== null) as unknown as AuthService['isSignedIn'],
      isConfigured: overrides?.isConfigured ?? false,
      signIn: jasmine.createSpy('signIn'),
      signOut: jasmine.createSpy('signOut')
    } as unknown as AuthService;

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        provideRouter([]),
        ...provideFakeAuth(),
        { provide: AuthService, useValue: authStub }
      ]
    }).compileComponents();
    const fixture = TestBed.createComponent(ProfileComponent);
    fixture.detectChanges();
    return { fixture, authStub };
  }

  it('renders the signed-out card when user is anonymous', async () => {
    const { fixture } = await create({ user: null, isConfigured: true });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('You are signed out');
    expect(text).toContain('Sign in');
  });

  it('disables the sign-in button when auth is not configured', async () => {
    const { fixture } = await create({ user: null, isConfigured: false });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Sign in (not configured)');
    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button?.hasAttribute('disabled')).toBe(true);
  });

  it('renders display name and email when signed in', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      isConfigured: true
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('ada@example.com');
    expect(text).toContain('Sign out');
  });

  it('shows "Not provided" fallback when email claim is missing', async () => {
    const { fixture } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: undefined },
      isConfigured: true
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Not provided');
  });

  it('calls signIn on the sign-in button click', async () => {
    const { fixture, authStub } = await create({ user: null, isConfigured: true });
    fixture.componentInstance.onSignIn();
    expect(authStub.signIn).toHaveBeenCalled();
  });

  it('calls signOut on the sign-out button click', async () => {
    const { fixture, authStub } = await create({
      user: { id: 'oid-1', displayName: 'Ada', email: 'ada@example.com' },
      isConfigured: true
    });
    fixture.componentInstance.onSignOut();
    expect(authStub.signOut).toHaveBeenCalled();
  });
});
