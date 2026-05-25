import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthService } from './auth.service';

describe('authGuard', () => {
  function setup(signedIn: boolean) {
    const auth = {
      isSignedIn: (() => signedIn) as AuthService['isSignedIn'],
      signIn: vi.fn(),
    };
    const router = {
      createUrlTree: vi.fn().mockReturnValue({} as UrlTree),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
      ],
    });
    return { auth, router };
  }

  it('allows activation when signed in', () => {
    const { auth, router } = setup(true);
    const result = TestBed.runInInjectionContext(() => (authGuard as () => boolean | UrlTree)());
    expect(result).toBe(true);
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(router.createUrlTree).not.toHaveBeenCalled();
  });

  it('redirects to / and triggers sign-in when anonymous', () => {
    const { auth, router } = setup(false);
    const result = TestBed.runInInjectionContext(() => (authGuard as () => boolean | UrlTree)());
    expect(auth.signIn).toHaveBeenCalled();
    expect(router.createUrlTree).toHaveBeenCalledWith(['/']);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('object');
  });
});
