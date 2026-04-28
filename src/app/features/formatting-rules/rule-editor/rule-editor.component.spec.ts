import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, throwError, BehaviorSubject } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { MatSnackBar } from '@angular/material/snack-bar';
import { signal } from '@angular/core';

import { RuleEditorComponent } from './rule-editor.component';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import type {
  FormattingRule,
  FormattingRuleSet
} from '../../../core/api/models';

function isThrowable(x: unknown): x is Error | HttpErrorResponse {
  return x instanceof Error || x instanceof HttpErrorResponse;
}

function ruleSet(overrides: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'rs-1',
    userId: 'u1',
    name: 'My set',
    rules: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

function rule(overrides: Partial<FormattingRule> = {}): FormattingRule {
  return {
    id: 'r1',
    target: 'value',
    matchType: 'contains',
    matchValue: 'foo',
    caseSensitive: false,
    style: { backgroundColor: '#ffe4b5' },
    ...overrides
  };
}

interface SetupOpts {
  paramId?: string;
  initialCache?: FormattingRuleSet[] | null;
  getResult?: FormattingRuleSet | Error | HttpErrorResponse;
  updateResult?: FormattingRuleSet | Error | HttpErrorResponse;
}

function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();
  const cache = signal<FormattingRuleSet[] | null>(
    opts.initialCache === undefined ? null : opts.initialCache
  );
  const params = new BehaviorSubject(
    convertToParamMap({ id: opts.paramId ?? 'rs-1' })
  );

  const stub = {
    ruleSets: cache.asReadonly(),
    get: jasmine.createSpy('get').and.callFake(() =>
      isThrowable(opts.getResult)
        ? throwError(() => opts.getResult)
        : of(opts.getResult ?? ruleSet())
    ),
    update: jasmine.createSpy('update').and.callFake(() =>
      isThrowable(opts.updateResult)
        ? throwError(() => opts.updateResult)
        : of(opts.updateResult ?? ruleSet({ version: 2 }))
    )
  };
  const snack = { open: jasmine.createSpy('open') };

  TestBed.configureTestingModule({
    imports: [RuleEditorComponent],
    providers: [
      ...provideFakeAuth(),
      provideRouter([]),
      { provide: RuleSetsService, useValue: stub },
      { provide: MatSnackBar, useValue: snack },
      { provide: ActivatedRoute, useValue: { paramMap: params } }
    ]
  });

  const fixture = TestBed.createComponent(RuleEditorComponent);
  return { fixture, stub, snack, cache };
}

describe('RuleEditorComponent', () => {
  it('loads from cache when present without calling get()', async () => {
    const cached = ruleSet({ id: 'rs-1', name: 'Cached' });
    const { fixture, stub } = setup({ initialCache: [cached] });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(stub.get).not.toHaveBeenCalled();
    expect(fixture.componentInstance.draft()?.name).toBe('Cached');
  });

  it('falls back to get() when cache misses', async () => {
    const fetched = ruleSet({ id: 'rs-1', name: 'Fetched' });
    const { fixture, stub } = setup({
      initialCache: [],
      getResult: fetched
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(stub.get).toHaveBeenCalledWith('rs-1');
    expect(fixture.componentInstance.draft()?.name).toBe('Fetched');
  });

  it('redirects to /formatting-rules with snackbar on 404', async () => {
    const err = new HttpErrorResponse({ status: 404 });
    const { fixture, snack } = setup({ getResult: err });
    const router = TestBed.inject(Router);
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);

    fixture.detectChanges();
    await fixture.whenStable();

    expect(navSpy).toHaveBeenCalledWith(['/formatting-rules']);
    expect(snack.open).toHaveBeenCalled();
  });

  describe('with a loaded draft', () => {
    async function loaded() {
      const set = ruleSet({ rules: [rule()] });
      const ctx = setup({ initialCache: [set] });
      ctx.fixture.detectChanges();
      await ctx.fixture.whenStable();
      ctx.fixture.detectChanges();
      return ctx;
    }

    it('setName updates the draft', async () => {
      const { fixture } = await loaded();
      fixture.componentInstance.setName('Renamed');
      expect(fixture.componentInstance.draft()?.name).toBe('Renamed');
    });

    it('addRule appends a default rule', async () => {
      const { fixture } = await loaded();
      const before = fixture.componentInstance.draft()!.rules.length;
      fixture.componentInstance.addRule();
      const rules = fixture.componentInstance.draft()!.rules;
      expect(rules.length).toBe(before + 1);
      const added = rules[rules.length - 1];
      expect(added.target).toBe('value');
      expect(added.matchType).toBe('contains');
      expect(added.matchValue).toBe('');
    });

    it('removeRule deletes the right entry', async () => {
      const { fixture } = await loaded();
      fixture.componentInstance.addRule();
      const ids = fixture.componentInstance.draft()!.rules.map((r) => r.id);
      fixture.componentInstance.removeRule(0);
      const after = fixture.componentInstance.draft()!.rules.map((r) => r.id);
      expect(after).toEqual([ids[1]]);
    });

    it('moveRule respects boundaries', async () => {
      const { fixture } = await loaded();
      fixture.componentInstance.addRule();
      const before = fixture.componentInstance.draft()!.rules.map((r) => r.id);
      fixture.componentInstance.moveRule(0, -1);
      expect(fixture.componentInstance.draft()!.rules.map((r) => r.id)).toEqual(before);
      fixture.componentInstance.moveRule(1, 1);
      expect(fixture.componentInstance.draft()!.rules.map((r) => r.id)).toEqual(before);
      fixture.componentInstance.moveRule(0, 1);
      expect(fixture.componentInstance.draft()!.rules.map((r) => r.id)).toEqual([
        before[1],
        before[0]
      ]);
    });

    it('patchRule and patchStyle merge correctly', async () => {
      const { fixture } = await loaded();
      fixture.componentInstance.patchRule(0, { matchValue: 'baz' });
      fixture.componentInstance.patchStyle(0, { bold: true });
      const r0 = fixture.componentInstance.draft()!.rules[0];
      expect(r0.matchValue).toBe('baz');
      expect(r0.style.bold).toBe(true);
      // Existing style fields preserved
      expect(r0.style.backgroundColor).toBe('#ffe4b5');
    });

    it('setIcon clears icon on empty string and sets known icons', async () => {
      const { fixture } = await loaded();
      fixture.componentInstance.setIcon(0, 'warning');
      expect(fixture.componentInstance.draft()!.rules[0].style.icon).toBe('warning');
      fixture.componentInstance.setIcon(0, '');
      expect(fixture.componentInstance.draft()!.rules[0].style.icon).toBeUndefined();
      fixture.componentInstance.setIcon(0, 'not-an-icon');
      expect(fixture.componentInstance.draft()!.rules[0].style.icon).toBeUndefined();
    });

    it('ruleLabel formats target/match/value', async () => {
      const { fixture } = await loaded();
      const label = fixture.componentInstance.ruleLabel(rule());
      expect(label).toBe('value contains "foo"');
    });

    it('onSave calls update with id, payload, and version', async () => {
      const { fixture, stub } = await loaded();
      await fixture.componentInstance.onSave();
      expect(stub.update).toHaveBeenCalledWith(
        'rs-1',
        jasmine.objectContaining({
          name: 'My set',
          rules: jasmine.any(Array)
        }),
        1
      );
      expect(fixture.componentInstance.draft()?.version).toBe(2);
      expect(fixture.componentInstance.saveState()).toBe('saved');
    });

    it('onSave on 412 surfaces the conflict snackbar', async () => {
      const set = ruleSet({ rules: [rule()] });
      const conflict = new HttpErrorResponse({ status: 412 });
      const ctx = setup({
        initialCache: [set],
        updateResult: conflict
      });
      ctx.fixture.detectChanges();
      await ctx.fixture.whenStable();
      ctx.fixture.detectChanges();

      await ctx.fixture.componentInstance.onSave();
      expect(ctx.snack.open).toHaveBeenCalledWith(
        jasmine.stringMatching(/changed in another tab/),
        jasmine.any(String),
        jasmine.any(Object)
      );
      expect(ctx.fixture.componentInstance.saveState()).toBe('error');
    });

    it('onSave on generic failure surfaces the failed snackbar', async () => {
      const set = ruleSet({ rules: [rule()] });
      const err = new HttpErrorResponse({ status: 500 });
      const ctx = setup({
        initialCache: [set],
        updateResult: err
      });
      ctx.fixture.detectChanges();
      await ctx.fixture.whenStable();
      ctx.fixture.detectChanges();

      await ctx.fixture.componentInstance.onSave();
      expect(ctx.snack.open).toHaveBeenCalledWith(
        jasmine.stringMatching(/Save failed/),
        jasmine.any(String),
        jasmine.any(Object)
      );
      expect(ctx.fixture.componentInstance.saveState()).toBe('error');
    });
  });
});
