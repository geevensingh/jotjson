import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ClipboardCopyService } from '../../../../core/clipboard/clipboard-copy.service';
import {
  DecodedValueDialogComponent,
  type DecodedValueDialogData,
} from './decoded-value-dialog.component';

describe('DecodedValueDialogComponent', () => {
  let close: jasmine.Spy;
  let copyWithToast: jasmine.Spy;

  function createWith(data: DecodedValueDialogData) {
    close = jasmine.createSpy('ref.close');
    copyWithToast = jasmine.createSpy('copyWithToast').and.resolveTo(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DecodedValueDialogComponent],
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: ClipboardCopyService, useValue: { copyWithToast } },
      ],
    });
    const fixture = TestBed.createComponent(DecodedValueDialogComponent);
    fixture.detectChanges();
    return fixture;
  }

  describe('rendering', () => {
    it('renders multi-line decoded content with monotonic line numbers', () => {
      const fixture = createWith({ value: 'first\nsecond\nthird', pathString: '$.note' });
      const lines = (fixture.nativeElement as HTMLElement).querySelectorAll('.decoded-line');
      expect(lines.length).toBe(3);
      expect(lines[0]?.querySelector('.decoded-line__no')?.textContent?.trim()).toBe('1');
      expect(lines[2]?.querySelector('.decoded-line__no')?.textContent?.trim()).toBe('3');
      expect(lines[0]?.querySelector('.decoded-line__text')?.textContent).toBe('first');
      expect(lines[1]?.querySelector('.decoded-line__text')?.textContent).toBe('second');
      expect(lines[2]?.querySelector('.decoded-line__text')?.textContent).toBe('third');
    });

    it('renders an empty value as a single empty line so the gutter remains visible', () => {
      const fixture = createWith({ value: '', pathString: '$.note' });
      const lines = (fixture.nativeElement as HTMLElement).querySelectorAll('.decoded-line');
      expect(lines.length).toBe(1);
      expect(lines[0]?.querySelector('.decoded-line__no')?.textContent?.trim()).toBe('1');
      expect(lines[0]?.querySelector('.decoded-line__text')?.textContent).toBe('');
    });

    it('treats CRLF and CR-only payloads the same as LF', () => {
      const fixture = createWith({ value: 'a\r\nb\rc\nd', pathString: '$.x' });
      const texts = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.decoded-line__text'),
      ).map((s) => s.textContent);
      expect(texts).toEqual(['a', 'b', 'c', 'd']);
    });

    it('renders a non-decodable long single-line value as one row', () => {
      const long = 'x'.repeat(500);
      const fixture = createWith({ value: long, pathString: '$.id' });
      const lines = (fixture.nativeElement as HTMLElement).querySelectorAll('.decoded-line');
      expect(lines.length).toBe(1);
      expect(lines[0]?.querySelector('.decoded-line__text')?.textContent).toBe(long);
    });

    it('renders the originating path in the title bar for orientation', () => {
      const fixture = createWith({ value: 'a', pathString: '$.deeply.nested.path[3]' });
      const path = (fixture.nativeElement as HTMLElement).querySelector('.decoded-title__path');
      expect(path?.textContent).toContain('$.deeply.nested.path[3]');
    });
  });

  describe('copy', () => {
    it('routes copy through ClipboardCopyService.copyWithToast with the raw value', () => {
      const fixture = createWith({ value: 'multi\nline', pathString: '$.note' });
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__copy',
      ) as HTMLButtonElement;
      button.click();
      expect(copyWithToast).toHaveBeenCalledTimes(1);
      const args = copyWithToast.calls.mostRecent().args;
      expect(args[0]).toBe('multi\nline');
      const messages = args[1] as { success: string; failed: string; unsupported: string };
      expect(messages.success.length).toBeGreaterThan(0);
      expect(messages.failed.length).toBeGreaterThan(0);
      expect(messages.unsupported.length).toBeGreaterThan(0);
    });

    it('does not throw when the underlying copy resolves to false (failed path)', () => {
      copyWithToast = jasmine.createSpy('copyWithToast').and.resolveTo(false);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [DecodedValueDialogComponent],
        providers: [
          { provide: MatDialogRef, useValue: { close: jasmine.createSpy('close') } },
          { provide: MAT_DIALOG_DATA, useValue: { value: 'a', pathString: '$.x' } },
          { provide: ClipboardCopyService, useValue: { copyWithToast } },
        ],
      });
      const fixture = TestBed.createComponent(DecodedValueDialogComponent);
      fixture.detectChanges();
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__copy',
      ) as HTMLButtonElement;
      expect(() => button.click()).not.toThrow();
      expect(copyWithToast).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the underlying copy rejects (unsupported environment)', () => {
      copyWithToast = jasmine.createSpy('copyWithToast').and.rejectWith(new Error('unsupported'));
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [DecodedValueDialogComponent],
        providers: [
          { provide: MatDialogRef, useValue: { close: jasmine.createSpy('close') } },
          { provide: MAT_DIALOG_DATA, useValue: { value: 'a', pathString: '$.x' } },
          { provide: ClipboardCopyService, useValue: { copyWithToast } },
        ],
      });
      const fixture = TestBed.createComponent(DecodedValueDialogComponent);
      fixture.detectChanges();
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__copy',
      ) as HTMLButtonElement;
      expect(() => button.click()).not.toThrow();
    });
  });

  describe('close', () => {
    it('closes via MatDialogRef when the close button is clicked', () => {
      const fixture = createWith({ value: 'a', pathString: '$.x' });
      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
      // The close button is the last action button.
      const closeBtn = buttons[buttons.length - 1] as HTMLButtonElement;
      closeBtn.click();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
