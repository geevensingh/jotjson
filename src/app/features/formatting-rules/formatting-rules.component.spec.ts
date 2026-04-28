import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormattingRulesComponent } from './formatting-rules.component';
import { RuleSetsService } from '../../core/api/rule-sets.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import type { FormattingRuleSet } from '../../core/api/models';
import { signal } from '@angular/core';

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
  createResult?: FormattingRuleSet | Error;
}

function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();

  const cache = signal<FormattingRuleSet[] | null>(
    opts.initialCache === undefined ? null : opts.initialCache
  );

  const stub = {
    ruleSets: cache.asReadonly(),
    list: jasmine.createSpy('list').and.callFake(() => {
      if (opts.listResult instanceof Error) {
        return throwError(() => opts.listResult as Error);
      }
      const sets = (opts.listResult as FormattingRuleSet[]) ?? [];
      cache.set(sets);
      return of(sets);
    }),
    create: jasmine.createSpy('create').and.callFake(() => {
      if (opts.createResult instanceof Error) {
        return throwError(() => opts.createResult as Error);
      }
      return of(opts.createResult ?? ruleSet({ id: 'rs-new', name: 'New rule set' }));
    })
  };
  const snack = { open: jasmine.createSpy('open') };

  TestBed.configureTestingModule({
    imports: [FormattingRulesComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: RuleSetsService, useValue: stub },
      { provide: MatSnackBar, useValue: snack }
    ]
  });

  const fixture = TestBed.createComponent(FormattingRulesComponent);
  return { fixture, stub, snack, cache };
}

describe('FormattingRulesComponent', () => {
  it('warms cache via list() on init and renders cards', async () => {
    const sets = [
      ruleSet({ id: 'a', name: 'Alpha', createdAt: '2024-01-02T00:00:00Z' }),
      ruleSet({ id: 'b', name: 'Bravo', createdAt: '2024-01-01T00:00:00Z' })
    ];
    const { fixture, stub } = setup({ listResult: sets });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(stub.list).toHaveBeenCalled();
    const names = Array.from(
      fixture.nativeElement.querySelectorAll('.rule-set-name')
    ).map((el) => (el as Element).textContent);
    // sorted by createdAt asc -> Bravo first
    expect(names).toEqual(['Bravo', 'Alpha']);
  });

  it('shows empty state when there are no rule sets', async () => {
    const { fixture } = setup({ listResult: [] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('.status');
    expect(empty?.textContent).toContain('do not have any rule sets');
  });

  it('shows error state when list() fails', async () => {
    const { fixture } = setup({ listResult: new Error('boom') });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const err = fixture.nativeElement.querySelector('.status-error');
    expect(err).toBeTruthy();
  });

  it('creates a new rule set and navigates into the editor', async () => {
    const created = ruleSet({ id: 'rs-new' });
    const { fixture, stub } = setup({
      listResult: [],
      createResult: created
    });
    const router = TestBed.inject(Router);
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="new-rule-set"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();

    expect(stub.create).toHaveBeenCalledWith(
      jasmine.objectContaining({ rules: [] })
    );
    expect(navSpy).toHaveBeenCalledWith(['/formatting-rules', 'rs-new']);
  });

  it('surfaces a snackbar when create fails', async () => {
    const { fixture, snack } = setup({
      listResult: [],
      createResult: new Error('nope')
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector(
      '[data-testid="new-rule-set"]'
    ) as HTMLButtonElement;
    btn.click();
    await fixture.whenStable();

    expect(snack.open).toHaveBeenCalled();
  });
});
