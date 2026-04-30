import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormattingRulesComponent } from './formatting-rules.component';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { ConfirmDialogComponent } from '../../shared/dialogs/confirm-dialog/confirm-dialog.component';
import { ClonePresetDialogComponent } from '../home/rule-sets-toolbar/clone-preset-dialog.component';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { FormattingRuleSet } from '../../core/api/models';

function ruleSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'rs-1',
    userId: 'u1',
    name: 'Set 1',
    rules: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

interface SetupOpts {
  initialCache?: FormattingRuleSet[] | null;
  listResult?: FormattingRuleSet[] | Error;
  createResult?: FormattingRuleSet | Error | HttpErrorResponse;
  defaults?: string[];
}

function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();

  const cache = signal<FormattingRuleSet[] | null>(
    opts.initialCache === undefined ? null : opts.initialCache
  );
  const defaultsSig = signal<string[]>(opts.defaults ?? []);

  const stub = {
    ruleSets: cache.asReadonly(),
    defaultRuleSetIds: defaultsSig.asReadonly(),
    list: jasmine.createSpy('list').and.callFake(() => {
      if (opts.listResult instanceof Error) {
        return throwError(() => opts.listResult as Error);
      }
      const sets = (opts.listResult as FormattingRuleSet[]) ?? [];
      cache.set(sets);
      return of(sets);
    }),
    create: jasmine.createSpy('create').and.callFake(() => {
      if (opts.createResult instanceof Error || opts.createResult instanceof HttpErrorResponse) {
        return throwError(() => opts.createResult);
      }
      const created = opts.createResult ?? ruleSet({ id: 'rs-new', name: 'New rule set' });
      const next = [...(cache() ?? []), created];
      cache.set(next);
      return of(created);
    }),
    update: jasmine.createSpy('update').and.returnValue(of(ruleSet())),
    delete: jasmine.createSpy('delete').and.returnValue(of(void 0)),
    get: jasmine.createSpy('get').and.returnValue(of(ruleSet())),
    refresh: jasmine.createSpy('refresh'),
    toggleDefault: jasmine.createSpy('toggleDefault').and.callFake((id: string) => {
      const cur = defaultsSig();
      if (cur.includes(id)) {
        defaultsSig.set(cur.filter((x) => x !== id));
      } else {
        defaultsSig.set([...cur, id]);
      }
    })
  };

  const snack = { open: jasmine.createSpy('open') };

  const prefsSig = signal<{ defaultRuleSetIds: string[] }>({
    defaultRuleSetIds: opts.defaults ?? []
  });
  const syncStateSig = signal<'anon' | 'hydrating' | 'synced' | 'error'>('synced');
  const preferences = {
    prefs: prefsSig.asReadonly(),
    syncState: syncStateSig.asReadonly(),
    update: jasmine.createSpy('preferences.update').and.callFake(
      (patch: { defaultRuleSetIds?: string[] }) => {
        if (patch.defaultRuleSetIds) {
          prefsSig.set({ defaultRuleSetIds: patch.defaultRuleSetIds });
          defaultsSig.set(patch.defaultRuleSetIds);
        }
      }
    ),
    __syncStateSig: syncStateSig
  };

  const dialogRefStub = {
    afterClosed: jasmine.createSpy('afterClosed').and.returnValue(of(undefined))
  };
  const dialog = {
    open: jasmine.createSpy('dialog.open').and.returnValue(dialogRefStub)
  };

  TestBed.configureTestingModule({
    imports: [FormattingRulesComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: RuleSetsService, useValue: stub },
      { provide: MatSnackBar, useValue: snack },
      { provide: MatDialog, useValue: dialog },
      { provide: PreferencesService, useValue: preferences }
    ]
  });

  const fixture = TestBed.createComponent(FormattingRulesComponent);
  return {
    fixture,
    stub,
    snack,
    cache,
    defaultsSig,
    preferences,
    dialog,
    dialogRefStub
  };
}

async function settle(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('FormattingRulesComponent (M6d-1 baseline)', () => {
  it('warms cache via list() on init and renders cards', async () => {
    const sets = [
      ruleSet({ id: 'a', name: 'Alpha', createdAt: '2024-01-02T00:00:00Z' }),
      ruleSet({ id: 'b', name: 'Bravo', createdAt: '2024-01-01T00:00:00Z' })
    ];
    const { fixture, stub } = setup({ listResult: sets });
    await settle(fixture);

    expect(stub.list).toHaveBeenCalled();
    const names = Array.from(
      fixture.nativeElement.querySelectorAll('.rule-set-name')
    ).map((el) => (el as Element).textContent);
    expect(names).toEqual(['Bravo', 'Alpha']);
  });

  it('shows empty state when there are no rule sets', async () => {
    const { fixture } = setup({ listResult: [] });
    await settle(fixture);

    const empty = fixture.nativeElement.querySelector('.status');
    expect(empty?.textContent).toContain('do not have any rule sets');
  });

  it('shows error state when list() fails', async () => {
    const { fixture } = setup({ listResult: new Error('boom') });
    await settle(fixture);

    const err = fixture.nativeElement.querySelector('.status-error');
    expect(err).toBeTruthy();
  });

  it('creates a new rule set and navigates into the editor', async () => {
    const created = ruleSet({ id: 'rs-new' });
    const { fixture, stub } = setup({ listResult: [], createResult: created });
    const router = TestBed.inject(Router);
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);

    await settle(fixture);
    const btn = fixture.nativeElement.querySelector(
      '[data-testid="new-rule-set"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();

    expect(stub.create).toHaveBeenCalledWith(jasmine.objectContaining({ rules: [] }));
    expect(navSpy).toHaveBeenCalledWith(['/formatting-rules', 'rs-new']);
  });

  it('surfaces a snackbar when create fails', async () => {
    const { fixture, snack } = setup({
      listResult: [],
      createResult: new Error('nope')
    });
    await settle(fixture);

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="new-rule-set"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();

    expect(snack.open).toHaveBeenCalled();
  });
});

describe('FormattingRulesComponent - M6e card actions', () => {
  it('star reflects defaults and clicking toggles via service', async () => {
    const sets = [
      ruleSet({ id: 'a', name: 'Alpha', createdAt: '2024-01-01T00:00:00Z' }),
      ruleSet({ id: 'b', name: 'Bravo', createdAt: '2024-01-02T00:00:00Z' })
    ];
    const { fixture, stub } = setup({ listResult: sets, defaults: ['a'] });
    await settle(fixture);

    const stars = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="default-star"]')
    ) as HTMLButtonElement[];
    expect(stars.length).toBe(2);
    expect(stars[0].getAttribute('aria-pressed')).toBe('true');
    expect(stars[0].getAttribute('aria-label')).toContain('Stop applying');
    expect(stars[1].getAttribute('aria-pressed')).toBe('false');
    expect(stars[1].getAttribute('aria-label')).toContain('Apply rule set');

    stars[1].click();
    expect(stub.toggleDefault).toHaveBeenCalledWith('b');
  });

  it('snacks when preferences.syncState transitions into error', async () => {
    const sets = [ruleSet({ id: 'a' })];
    const { fixture, snack, preferences } = setup({ listResult: sets });
    await settle(fixture);

    snack.open.calls.reset();
    preferences.__syncStateSig.set('error');
    fixture.detectChanges();

    expect(snack.open).toHaveBeenCalled();
    expect(snack.open.calls.mostRecent().args[0]).toContain('rule sets are applied');
  });

  it('rename happy path: pencil click -> Enter -> update + snack', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha', version: 3 })];
    const { fixture, stub, snack } = setup({ listResult: sets });
    stub.update.and.returnValue(of(ruleSet({ id: 'a', name: 'Renamed', version: 4 })));
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="rename-pencil"]'
    ) as HTMLButtonElement).click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(stub.update).toHaveBeenCalledWith(
      'a',
      jasmine.objectContaining({ name: 'Renamed' }),
      3
    );
    expect(snack.open).toHaveBeenCalled();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="rename-input"]')).toBeNull();
  });

  it('rename Escape cancels without calling update', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha' })];
    const { fixture, stub } = setup({ listResult: sets });
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="rename-pencil"]'
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
    input.value = 'New';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(stub.update).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="rename-input"]')).toBeNull();
  });

  it('rename blur cancels without calling update', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha' })];
    const { fixture, stub } = setup({ listResult: sets });
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="rename-pencil"]'
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
    input.value = 'New';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(stub.update).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="rename-input"]')).toBeNull();
  });

  it('rename validation: empty + too-long do NOT call update and show inline error', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha' })];
    const { fixture, stub } = setup({ listResult: sets });
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="rename-pencil"]'
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    fixture.componentInstance.commitRename(sets[0]);
    fixture.detectChanges();
    expect(stub.update).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[data-testid="rename-error"]')?.textContent
    ).toContain('required');

    input.value = 'x'.repeat(81);
    input.dispatchEvent(new Event('input'));
    fixture.componentInstance.commitRename(sets[0]);
    fixture.detectChanges();
    expect(stub.update).not.toHaveBeenCalled();
    expect(
      fixture.nativeElement.querySelector('[data-testid="rename-error"]')?.textContent
    ).toContain('too long');
  });

  it('rename 412: refetches, repopulates input, stays in rename mode with conflict message', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha', version: 3 })];
    const { fixture, stub } = setup({ listResult: sets });
    stub.update.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 412, statusText: 'Precondition Failed' }))
    );
    stub.get.and.returnValue(
      of(ruleSet({ id: 'a', name: 'New Name From Server', version: 4 }))
    );
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="rename-pencil"]'
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement;
    input.value = 'My Rename';
    input.dispatchEvent(new Event('input'));
    fixture.componentInstance.commitRename(sets[0]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(stub.get).toHaveBeenCalledWith('a');
    const stillInput = fixture.nativeElement.querySelector(
      '[data-testid="rename-input"]'
    ) as HTMLInputElement | null;
    expect(stillInput).toBeTruthy();
    expect(stillInput!.value).toBe('New Name From Server');
    expect(
      fixture.nativeElement.querySelector('[data-testid="rename-error"]')?.textContent
    ).toContain('Updated elsewhere');
  });

  it('duplicate truncates name to fit the 80-char NAME_MAX', async () => {
    const longName = 'x'.repeat(78);
    const sets = [ruleSet({ id: 'a', name: longName })];
    const { fixture, stub } = setup({ listResult: sets });
    await settle(fixture);

    fixture.componentInstance.duplicateSet(sets[0]);
    await fixture.whenStable();

    expect(stub.create).toHaveBeenCalled();
    const sentName = stub.create.calls.mostRecent().args[0].name as string;
    expect(sentName.length).toBe(80);
    expect(sentName.endsWith(' (copy)')).toBe(true);
  });

  it('delete cancel (dialog returns false) does not call delete', async () => {
    const sets = [ruleSet({ id: 'a' })];
    const { fixture, stub, dialog, dialogRefStub } = setup({ listResult: sets });
    dialogRefStub.afterClosed.and.returnValue(of(false));
    await settle(fixture);

    await fixture.componentInstance.deleteSet(sets[0]);
    expect(dialog.open).toHaveBeenCalledWith(ConfirmDialogComponent, jasmine.any(Object));
    expect(stub.delete).not.toHaveBeenCalled();
  });

  it('delete confirmed calls service.delete', async () => {
    const sets = [ruleSet({ id: 'a', name: 'Alpha' })];
    const { fixture, stub, dialogRefStub } = setup({ listResult: sets, defaults: ['a'] });
    dialogRefStub.afterClosed.and.returnValue(of(true));
    await settle(fixture);

    await fixture.componentInstance.deleteSet(sets[0]);
    await fixture.whenStable();

    expect(stub.delete).toHaveBeenCalledWith('a');
  });

  it('delete 404 mirrors defaults scrub + refresh + already-deleted snack', async () => {
    const sets = [ruleSet({ id: 'a' })];
    const { fixture, stub, snack, preferences, dialogRefStub } = setup({
      listResult: sets,
      defaults: ['a']
    });
    dialogRefStub.afterClosed.and.returnValue(of(true));
    stub.delete.and.returnValue(
      throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }))
    );
    await settle(fixture);
    snack.open.calls.reset();

    await fixture.componentInstance.deleteSet(sets[0]);
    await fixture.whenStable();

    expect(stub.refresh).toHaveBeenCalled();
    expect(preferences.update).toHaveBeenCalledWith({ defaultRuleSetIds: [] });
    expect(snack.open.calls.mostRecent().args[0]).toContain('already deleted');
  });

  it('clone-preset dialog success navigates into the editor', async () => {
    const { fixture, dialog, dialogRefStub } = setup({ listResult: [] });
    const cloned = ruleSet({ id: 'rs-clone' });
    dialogRefStub.afterClosed.and.returnValue(
      of({ preset: { id: 'p1', name: 'P', rules: [] }, cloned })
    );
    const router = TestBed.inject(Router);
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    await settle(fixture);

    (fixture.nativeElement.querySelector(
      '[data-testid="clone-preset"]'
    ) as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(dialog.open).toHaveBeenCalledWith(
      ClonePresetDialogComponent,
      jasmine.any(Object)
    );
    expect(navSpy).toHaveBeenCalledWith(['/formatting-rules', 'rs-clone']);
  });

  it('per-row busy gate: while delete is in flight, that row is disabled but others are not', async () => {
    const sets = [
      ruleSet({ id: 'a', name: 'Alpha', createdAt: '2024-01-01T00:00:00Z' }),
      ruleSet({ id: 'b', name: 'Bravo', createdAt: '2024-01-02T00:00:00Z' })
    ];
    const { fixture, stub, dialogRefStub } = setup({ listResult: sets });
    dialogRefStub.afterClosed.and.returnValue(of(true));
    const deleteSubject = new Subject<void>();
    stub.delete.and.returnValue(deleteSubject.asObservable());
    await settle(fixture);

    void fixture.componentInstance.deleteSet(sets[0]);
    await fixture.whenStable();
    fixture.detectChanges();

    const cards = Array.from(
      fixture.nativeElement.querySelectorAll('.rule-set-card')
    ) as HTMLElement[];
    expect(cards[0].classList.contains('is-busy')).toBe(true);
    expect(cards[1].classList.contains('is-busy')).toBe(false);
    const aStar = cards[0].querySelector(
      '[data-testid="default-star"]'
    ) as HTMLButtonElement;
    const bStar = cards[1].querySelector(
      '[data-testid="default-star"]'
    ) as HTMLButtonElement;
    expect(aStar.disabled).toBe(true);
    expect(bStar.disabled).toBe(false);

    deleteSubject.next();
    deleteSubject.complete();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelectorAll('.rule-set-card')[0] as HTMLElement).classList.contains(
        'is-busy'
      )
    ).toBe(false);
  });

  it('onCreate 409 surfaces quota-specific snack', async () => {
    const { fixture, snack } = setup({
      listResult: [],
      createResult: new HttpErrorResponse({ status: 409, statusText: 'Conflict' })
    });
    await settle(fixture);
    snack.open.calls.reset();

    (fixture.nativeElement.querySelector(
      '[data-testid="new-rule-set"]'
    ) as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(snack.open).toHaveBeenCalled();
    expect(snack.open.calls.mostRecent().args[0]).toContain('rule set limit');
  });
});
