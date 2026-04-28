import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { MatDialogRef } from '@angular/material/dialog';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import type {
  FormattingRule,
  FormattingRuleSet,
  RuleSetPreset
} from '../../../core/api/models';
import { ClonePresetDialogComponent } from './clone-preset-dialog.component';

function rule(id: string): FormattingRule {
  return {
    id,
    target: 'key',
    matchType: 'contains',
    matchValue: 'x',
    caseSensitive: false,
    style: {}
  };
}

function makePreset(over: Partial<RuleSetPreset> = {}): RuleSetPreset {
  return {
    id: 'preset-' + (over.id ?? Math.random().toString(36).slice(2, 8)),
    name: 'Preset',
    rules: [rule('r1')],
    ...over
  };
}

function makeSet(over: Partial<FormattingRuleSet> = {}): FormattingRuleSet {
  return {
    id: 'cloned',
    userId: 'u1',
    name: 'Cloned',
    rules: [],
    version: 1,
    createdAt: '2026-04-27T00:00:00Z',
    updatedAt: '2026-04-27T00:00:00Z',
    ...over
  };
}

describe('ClonePresetDialogComponent', () => {
  let close: jasmine.Spy;

  beforeEach(() => {
    close = jasmine.createSpy('ref.close');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ClonePresetDialogComponent],
      providers: [
        ...provideFakeAuth(),
        { provide: MatDialogRef, useValue: { close } }
      ]
    });
  });

  function render() {
    const fixture = TestBed.createComponent(ClonePresetDialogComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the loading state before the presets resolve', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    spyOn(ruleSets, 'listPresets').and.returnValue(
      // Never emits - simulates pending request.
      new Observable<RuleSetPreset[]>(() => {
        /* no-op subscriber */
      })
    );
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Loading presets'
    );
  });

  it('lists presets returned from the service, with rule counts', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    spyOn(ruleSets, 'listPresets').and.returnValue(
      of([
        makePreset({ id: 'a', name: 'Alpha', rules: [rule('1')] }),
        makePreset({ id: 'b', name: 'Beta', rules: [rule('1'), rule('2')] })
      ])
    );
    const fixture = render();
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.preset-button'
    );
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain('Alpha');
    expect(buttons[0].textContent).toContain('1 rule');
    expect(buttons[1].textContent).toContain('Beta');
    expect(buttons[1].textContent).toContain('2 rules');
  });

  it('shows an inline error if loading presets fails', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    spyOn(ruleSets, 'listPresets').and.returnValue(
      throwError(() => new Error('boom'))
    );
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Could not load presets'
    );
  });

  it('clones the picked preset and closes with the result on success', fakeAsync(() => {
    const ruleSets = TestBed.inject(RuleSetsService);
    const preset = makePreset({ id: 'p1', name: 'Errors' });
    const cloned = makeSet({ id: 'cloned-1', name: 'Errors' });
    spyOn(ruleSets, 'listPresets').and.returnValue(of([preset]));
    const cloneSpy = spyOn(ruleSets, 'clonePreset').and.returnValue(of(cloned));

    const fixture = render();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.preset-button'
    ) as HTMLButtonElement;
    button.click();
    tick();

    expect(cloneSpy).toHaveBeenCalledWith('p1');
    expect(close).toHaveBeenCalledWith({ preset, cloned });
  }));

  it('shows an inline retry error and stays open if the clone POST fails', fakeAsync(() => {
    const ruleSets = TestBed.inject(RuleSetsService);
    const preset = makePreset({ id: 'p1', name: 'Errors' });
    spyOn(ruleSets, 'listPresets').and.returnValue(of([preset]));
    spyOn(ruleSets, 'clonePreset').and.returnValue(throwError(() => new Error('boom')));

    const fixture = render();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.preset-button'
    ) as HTMLButtonElement;
    button.click();
    tick();
    fixture.detectChanges();

    expect(close).not.toHaveBeenCalled();
    const err = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="clone-error"]'
    );
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain('Clone failed');
    // Buttons re-enabled.
    expect(button.disabled).toBe(false);
  }));

  it('disables preset buttons while a clone is in flight', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    spyOn(ruleSets, 'listPresets').and.returnValue(of([makePreset({ id: 'p1' })]));
    // Returns an Observable that never completes.
    spyOn(ruleSets, 'clonePreset').and.returnValue(
      new Observable<FormattingRuleSet>(() => {
        /* no-op subscriber */
      })
    );

    const fixture = render();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.preset-button'
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    expect(button.disabled).toBe(true);
  });

  it('cancel button closes the dialog with no result', () => {
    const ruleSets = TestBed.inject(RuleSetsService);
    spyOn(ruleSets, 'listPresets').and.returnValue(of([]));
    const fixture = render();
    const cancel = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button')
    ).find((b) => b.textContent?.trim() === 'Cancel') as HTMLButtonElement;
    cancel.click();
    expect(close).toHaveBeenCalledWith();
  });
});
