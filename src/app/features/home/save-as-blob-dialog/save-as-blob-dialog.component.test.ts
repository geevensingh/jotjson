import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { type Mock } from 'vitest';
import { TitleSuggesterService } from '../../../core/title-suggester/title-suggester.service';
import type { SuggestionCandidate } from '../../../core/title-suggester/types';
import {
  SaveAsBlobDialogComponent,
  type SaveAsBlobDialogData,
  type SaveAsBlobDialogResult,
} from './save-as-blob-dialog.component';

describe('SaveAsBlobDialogComponent', () => {
  function makeCandidate(value: string, confidence = 1): SuggestionCandidate {
    return { value, source: 'filename', confidence };
  }

  function setup(
    opts: {
      data?: Partial<SaveAsBlobDialogData>;
      candidates?: readonly SuggestionCandidate[];
    } = {},
  ) {
    const close = vi.fn();
    const ref = { close } as unknown as MatDialogRef<
      SaveAsBlobDialogComponent,
      SaveAsBlobDialogResult | undefined
    >;
    const suggest = vi.fn().mockReturnValue(opts.candidates ?? []);
    const suggester = { suggest } as unknown as TitleSuggesterService;
    const data: SaveAsBlobDialogData = {
      initialTitle: 'data',
      jsonText: '{"a":1}',
      parsed: { a: 1 },
      hasParseErrors: false,
      filename: 'data.json',
      ...opts.data,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SaveAsBlobDialogComponent],
      providers: [
        provideNoopAnimations(),
        { provide: MatDialogRef, useValue: ref },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: TitleSuggesterService, useValue: suggester },
      ],
    });
    const fixture = TestBed.createComponent(SaveAsBlobDialogComponent);
    fixture.detectChanges();
    return { fixture, close: close as Mock, suggest: suggest as Mock };
  }

  it('seeds the title input from data.initialTitle', () => {
    const { fixture } = setup({ data: { initialTitle: 'seeded-title' } });
    expect(fixture.componentInstance.title()).toBe('seeded-title');
  });

  it('Save closes with { title } when title is non-empty', () => {
    const { fixture, close } = setup();
    fixture.componentInstance.title.set('my title');
    fixture.componentInstance.onSave();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ title: 'my title' });
  });

  it('Save is a no-op when title is whitespace-only', () => {
    const { fixture, close } = setup();
    fixture.componentInstance.title.set('   ');
    fixture.componentInstance.onSave();
    expect(close).not.toHaveBeenCalled();
  });

  it('Save trims the title before closing', () => {
    const { fixture, close } = setup();
    fixture.componentInstance.title.set('  trimmed  ');
    fixture.componentInstance.onSave();
    expect(close).toHaveBeenCalledWith({ title: 'trimmed' });
  });

  it('Cancel closes with undefined', () => {
    const { fixture, close } = setup();
    fixture.componentInstance.onCancel();
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(undefined);
  });

  it('saveDisabled reflects empty / whitespace title', () => {
    const { fixture } = setup({ data: { initialTitle: '' } });
    expect(fixture.componentInstance.saveDisabled()).toBe(true);
    fixture.componentInstance.title.set('hello');
    expect(fixture.componentInstance.saveDisabled()).toBe(false);
    fixture.componentInstance.title.set('   ');
    expect(fixture.componentInstance.saveDisabled()).toBe(true);
  });

  it('Enter keydown invokes Save when not disabled', () => {
    const { fixture, close } = setup();
    fixture.componentInstance.title.set('keydown-save');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fixture.componentInstance.onTitleKeydown(event);
    expect(close).toHaveBeenCalledWith({ title: 'keydown-save' });
  });

  it('Enter keydown is ignored when saveDisabled', () => {
    const { fixture, close } = setup({ data: { initialTitle: '' } });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fixture.componentInstance.onTitleKeydown(event);
    expect(close).not.toHaveBeenCalled();
  });

  it('onTitleInput updates the title signal', () => {
    const { fixture } = setup();
    const input = document.createElement('input');
    input.value = 'typed';
    fixture.componentInstance.onTitleInput({ target: input } as unknown as Event);
    expect(fixture.componentInstance.title()).toBe('typed');
  });

  describe('wand integration', () => {
    it('onWandClick invokes TitleSuggesterService.suggest with the full input shape', () => {
      const { fixture, suggest } = setup({
        candidates: [makeCandidate('one'), makeCandidate('two')],
      });
      fixture.componentInstance.onWandClick();
      expect(suggest).toHaveBeenCalledWith({
        jsonText: '{"a":1}',
        parsed: { a: 1 },
        hasParseErrors: false,
        filename: 'data.json',
      });
      expect(fixture.componentInstance.suggestedTitles()).toEqual([
        makeCandidate('one'),
        makeCandidate('two'),
      ]);
    });

    it('onSuggestionSelected replaces the title with the chosen candidate', () => {
      const { fixture } = setup();
      fixture.componentInstance.onSuggestionSelected(makeCandidate('picked'));
      expect(fixture.componentInstance.title()).toBe('picked');
    });

    it('starts with an empty suggestion list before the wand click', () => {
      const { fixture } = setup({ candidates: [makeCandidate('lazy')] });
      expect(fixture.componentInstance.suggestedTitles()).toEqual([]);
      fixture.componentInstance.onWandClick();
      expect(fixture.componentInstance.suggestedTitles()).toEqual([makeCandidate('lazy')]);
    });
  });

  describe('dialog copy', () => {
    it('renders the fire-and-forget hint so users know subsequent Save still writes the file', () => {
      const { fixture } = setup();
      const hint = fixture.nativeElement.querySelector('.hint') as HTMLElement;
      expect(hint).not.toBeNull();
      expect(hint.textContent).toContain('Subsequent Save still writes the local file');
      expect(hint.textContent).toContain('create a new copy');
    });

    it('renders the lead paragraph explaining cloud-copy creation', () => {
      const { fixture } = setup();
      const lead = fixture.nativeElement.querySelector('.lead') as HTMLElement;
      expect(lead).not.toBeNull();
      expect(lead.textContent).toContain('cloud copy');
    });
  });
});
