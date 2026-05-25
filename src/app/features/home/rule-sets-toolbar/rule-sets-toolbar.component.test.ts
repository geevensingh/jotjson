import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { of, throwError } from 'rxjs';
import { type MockInstance } from 'vitest';
import { provideFakeAuth, signInFakeUser } from '../../../../testing/auth.testing';
import type {
  FormattingRuleSet,
  FormattingRuleSimple,
  RuleSetPreset,
} from '../../../core/api/models';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { ClonePresetDialogComponent } from './clone-preset-dialog.component';
import { RuleSetsToolbarComponent } from './rule-sets-toolbar.component';

const PREFS_KEY = 'jotjson.preferences.v1';

function rule(id: string, target: FormattingRuleSimple['target'] = 'key'): FormattingRuleSimple {
  return {
    id,
    target,
    matchType: 'contains',
    matchValue: 'x',
    caseSensitive: false,
    style: {},
  };
}

function makeSet(over: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'set-' + (over.id ?? Math.random().toString(36).slice(2, 8)),
    userId: 'user-1',
    name: 'Set',
    rules: [],
    version: 1,
    createdAt: '2026-04-27T00:00:00Z',
    updatedAt: '2026-04-27T00:00:00Z',
    ...over,
  };
}

function makePreset(over: Partial<RuleSetPreset> = {}): RuleSetPreset {
  return {
    id: 'preset-' + (over.id ?? Math.random().toString(36).slice(2, 8)),
    name: 'Preset',
    rules: [rule('r1')],
    ...over,
  };
}

/**
 * Set the rule-sets cache directly. Spying `list()` to return `of([...])`
 * is not enough because that bypasses the `tap()` inside the service body
 * that writes to the cache signal.
 */
function setCache(sets: FormattingRuleSet[] | null): void {
  const ruleSets = TestBed.inject(RuleSetsService);
  (
    ruleSets as unknown as {
      _serverSnapshot: { set(v: FormattingRuleSet[] | null): void };
    }
  )._serverSnapshot.set(sets);
}

describe('RuleSetsToolbarComponent', () => {
  let dialogStub: { open: MockInstance };
  let snackStub: { open: MockInstance };

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    dialogStub = { open: vi.fn() };
    snackStub = { open: vi.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RuleSetsToolbarComponent],
      providers: [
        ...provideFakeAuth(),
        { provide: MatDialog, useValue: dialogStub },
        { provide: MatSnackBar, useValue: snackStub },
      ],
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
  });

  function render() {
    const fixture = TestBed.createComponent(RuleSetsToolbarComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when the user is signed out', () => {
    const fixture = render();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="rule-sets-toolbar"]')).toBeNull();
  });

  it('does NOT call list() when signed out (avoids 401 storms on home)', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    const spy = vi.spyOn(ruleSets, 'list').mockReturnValue(of([]));
    render();
    expect(spy).not.toHaveBeenCalled();
  });

  describe('signed in', () => {
    beforeEach(() => {
      const auth = TestBed.inject(AuthService);
      signInFakeUser(auth);
    });

    it('calls list() on init when the cache is cold', () => {
      const ruleSets = TestBed.inject(RuleSetsService);
      const spy = vi.spyOn(ruleSets, 'list').mockReturnValue(of([]));
      render();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('skips list() when the cache is already warm', () => {
      setCache([makeSet({ id: 'a', name: 'A' })]);
      const ruleSets = TestBed.inject(RuleSetsService);
      const spy = vi.spyOn(ruleSets, 'list').mockReturnValue(of([]));
      render();
      expect(spy).not.toHaveBeenCalled();
    });

    it('renders one chip per cached rule set, sorted by name', () => {
      setCache([makeSet({ id: 'b', name: 'Beta' }), makeSet({ id: 'a', name: 'Alpha' })]);
      const fixture = render();
      const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('.chip');
      expect(chips.length).toBe(2);
      expect(chips[0].textContent?.trim()).toBe('Alpha');
      expect(chips[1].textContent?.trim()).toBe('Beta');
    });

    it('marks chips active when their id is in activeRuleSetIds', () => {
      const prefs = TestBed.inject(PreferencesService);
      setCache([makeSet({ id: 'a', name: 'A' }), makeSet({ id: 'b', name: 'B' })]);
      prefs.update({ activeRuleSetIds: ['a'] });

      const fixture = render();
      const a = (fixture.nativeElement as HTMLElement).querySelector(
        '.chip[data-set-id="a"]',
      ) as HTMLButtonElement;
      const b = (fixture.nativeElement as HTMLElement).querySelector(
        '.chip[data-set-id="b"]',
      ) as HTMLButtonElement;
      expect(a.classList.contains('chip--active')).toBe(true);
      expect(a.getAttribute('aria-pressed')).toBe('true');
      expect(b.classList.contains('chip--active')).toBe(false);
      expect(b.getAttribute('aria-pressed')).toBe('false');
    });

    it('toggles active state when a chip is clicked', () => {
      const prefs = TestBed.inject(PreferencesService);
      setCache([makeSet({ id: 'a', name: 'A' })]);
      const fixture = render();

      const chip = (fixture.nativeElement as HTMLElement).querySelector(
        '.chip[data-set-id="a"]',
      ) as HTMLButtonElement;
      chip.click();
      expect(prefs.prefs().activeRuleSetIds).toEqual(['a']);

      chip.click();
      expect(prefs.prefs().activeRuleSetIds).toEqual([]);
    });

    it('shows the empty state when the user has no rule sets', () => {
      setCache([]);
      const fixture = render();
      const empty = (fixture.nativeElement as HTMLElement).querySelector('.status--empty');
      expect(empty?.textContent?.trim()).toContain('No formatting rules yet');
    });

    it('always shows the "+ Clone preset" trigger (even with zero sets)', () => {
      setCache([]);
      const fixture = render();
      const trigger = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="clone-preset-trigger"]',
      );
      expect(trigger).not.toBeNull();
    });

    it('opens the clone-preset dialog when the trigger is clicked', () => {
      setCache([]);
      const ref = {
        afterClosed: () => of(undefined),
      } as unknown as MatDialogRef<ClonePresetDialogComponent>;
      dialogStub.open.mockReturnValue(ref);

      const fixture = render();
      const trigger = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="clone-preset-trigger"]',
      ) as HTMLButtonElement;
      trigger.click();

      expect(dialogStub.open).toHaveBeenCalledTimes(1);
      expect(dialogStub.open.mock.lastCall[0]).toBe(ClonePresetDialogComponent);
    });

    it('auto-activates and toasts on successful clone', fakeAsync(() => {
      const ruleSets = TestBed.inject(RuleSetsService);
      const prefs = TestBed.inject(PreferencesService);
      const cloned = makeSet({ id: 'cloned-1', name: 'Errors' });
      // Cache must contain the cloned set so setActives() does not filter it.
      setCache([cloned]);
      const setDefaultsSpy = vi.spyOn(ruleSets, 'setActives');

      const preset = makePreset({ id: 'p1', name: 'Error detection' });
      const ref = {
        afterClosed: () => of({ preset, cloned }),
      } as unknown as MatDialogRef<ClonePresetDialogComponent>;
      dialogStub.open.mockReturnValue(ref);

      // Pre-existing active id NOT in cache will be filtered by the service,
      // so the persisted list ends up just ['cloned-1']. We assert on the
      // arg passed to setActive (the toolbar's intent), not the persisted
      // value.
      prefs.update({ activeRuleSetIds: [] });

      const fixture = render();
      const trigger = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="clone-preset-trigger"]',
      ) as HTMLButtonElement;
      trigger.click();
      tick();

      expect(setDefaultsSpy).toHaveBeenCalledWith(['cloned-1']);
      expect(prefs.prefs().activeRuleSetIds).toEqual(['cloned-1']);
      expect(snackStub.open).toHaveBeenCalled();
      const toastMessage = snackStub.open.mock.lastCall[0] as string;
      expect(toastMessage).toContain('Error detection');
    }));

    it('does nothing when the user cancels the clone dialog', fakeAsync(() => {
      const ruleSets = TestBed.inject(RuleSetsService);
      setCache([]);
      const setDefaultsSpy = vi.spyOn(ruleSets, 'setActives');

      const ref = {
        afterClosed: () => of(undefined),
      } as unknown as MatDialogRef<ClonePresetDialogComponent>;
      dialogStub.open.mockReturnValue(ref);

      const fixture = render();
      const trigger = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="clone-preset-trigger"]',
      ) as HTMLButtonElement;
      trigger.click();
      tick();

      expect(setDefaultsSpy).not.toHaveBeenCalled();
      expect(snackStub.open).not.toHaveBeenCalled();
    }));

    it('does not crash when list() fails (the toolbar simply stays empty)', () => {
      const ruleSets = TestBed.inject(RuleSetsService);
      vi.spyOn(ruleSets, 'list').mockReturnValue(throwError(() => new Error('boom')));
      expect(() => render()).not.toThrow();
    });
  });
});
