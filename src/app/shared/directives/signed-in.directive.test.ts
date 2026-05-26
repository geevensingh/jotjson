import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { AuthUser } from '../../core/auth/auth-user';
import { AuthService } from '../../core/auth/auth.service';
import { SignedInDirective } from './signed-in.directive';

@Component({
  standalone: true,
  imports: [SignedInDirective],
  template: `<span *jjSignedIn class="target">yes</span>`,
})
class HostComponent {}

describe('SignedInDirective', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  describe('with real AuthService (configured env)', () => {
    function create() {
      TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [...provideFakeAuth()],
      });
      const fixture = TestBed.createComponent(HostComponent);
      const auth = TestBed.inject(AuthService);
      fixture.detectChanges();
      return { fixture, auth };
    }

    it('does not render when signed out', (ctx) => {
      const { fixture, auth } = create();
      ctx.skip(!auth.isConfigured, 'Auth not configured in this environment build.');
      expect(fixture.nativeElement.querySelector('.target')).toBeNull();
    });

    it('renders when a user signs in and hides again on sign out', (ctx) => {
      const { fixture, auth } = create();
      ctx.skip(!auth.isConfigured, 'Auth not configured in this environment build.');
      const userSignal = (auth as unknown as { userSignal: { set(v: AuthUser | null): void } })
        .userSignal;

      userSignal.set({ id: 'oid-1', displayName: 'T', email: 't@example.com' });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.target')).toBeTruthy();

      userSignal.set(null);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.target')).toBeNull();
    });
  });

  describe('with stubbed unconfigured AuthService', () => {
    it('stays hidden even when isSignedIn() returns true', () => {
      const signedIn = signal(true);
      const stubAuth = {
        isConfigured: false,
        isSignedIn: () => signedIn(),
      };
      TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [{ provide: AuthService, useValue: stubAuth }],
      });
      const fixture = TestBed.createComponent(HostComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.target')).toBeNull();
    });
  });
});
