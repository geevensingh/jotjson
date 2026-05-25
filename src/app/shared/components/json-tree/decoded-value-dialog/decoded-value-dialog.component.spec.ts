import { LiveAnnouncer } from '@angular/cdk/a11y';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ClipboardCopyService } from '../../../../core/clipboard/clipboard-copy.service';
import type { ExtractedJson } from '../../../../core/json/json-extractor.service';
import { LoggerService } from '../../../../core/telemetry/logger.service';
import {
  DecodedValueDialogComponent,
  type DecodedValueDialogData,
} from './decoded-value-dialog.component';

describe('DecodedValueDialogComponent', () => {
  let close: jasmine.Spy;
  let copyWithToast: jasmine.Spy;
  let loggerEvent: jasmine.Spy;
  let liveAnnounce: jasmine.Spy;

  const extractCandidate = {
    text: '{"a":1}',
    blockCount: 1,
    preservesComments: true,
    proseSegments: 0,
    hasComments: false,
  } satisfies ExtractedJson;

  function createWith(data: DecodedValueDialogData) {
    close = jasmine.createSpy('ref.close');
    copyWithToast = jasmine.createSpy('copyWithToast').and.resolveTo(true);
    loggerEvent = jasmine.createSpy('logger.event');
    liveAnnounce = jasmine.createSpy('liveAnnouncer.announce').and.resolveTo();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DecodedValueDialogComponent],
      providers: [
        { provide: MatDialogRef, useValue: { close } },
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: ClipboardCopyService, useValue: { copyWithToast } },
        { provide: LoggerService, useValue: { event: loggerEvent } },
        { provide: LiveAnnouncer, useValue: { announce: liveAnnounce } },
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
    it('routes copy through ClipboardCopyService.copyWithToast with the currently displayed value', () => {
      const fixture = createWith({ value: 'multi\nline', pathString: '$.note' });
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__copy',
      ) as HTMLButtonElement;
      button.click();
      expect(copyWithToast).toHaveBeenCalledTimes(1);
      const args = copyWithToast.calls.mostRecent().args;
      expect(args[0]).toBe('multi\nline');
      const messages = args[1] as { success: string; failed: string; unsupported: string };
      expect(messages.success).toBe('Value copied to clipboard.');
      expect(messages.failed).toBe('Failed to copy value.');
      expect(messages.unsupported.length).toBeGreaterThan(0);
    });

    it('renders the copy button with the row-level "Copy value" label', () => {
      const fixture = createWith({ value: 'a', pathString: '$.x' });
      const button = (fixture.nativeElement as HTMLElement).querySelector('.decoded-actions__copy');
      expect(button?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Copy value');
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
          { provide: LoggerService, useValue: { event: jasmine.createSpy('event') } },
          {
            provide: LiveAnnouncer,
            useValue: { announce: jasmine.createSpy('announce').and.resolveTo() },
          },
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
          { provide: LoggerService, useValue: { event: jasmine.createSpy('event') } },
          {
            provide: LiveAnnouncer,
            useValue: { announce: jasmine.createSpy('announce').and.resolveTo() },
          },
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

  describe('extract', () => {
    it('does not render the extract button when no extract candidate is provided', () => {
      const fixture = createWith({ value: 'a', pathString: '$.x' });
      const extractButton = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__extract',
      );
      expect(extractButton).toBeNull();
    });

    it('renders the extract button when an extract candidate is provided', () => {
      const fixture = createWith({
        value: '{"a":1}',
        pathString: '$.x',
        extractCandidate,
        extractPath: ['x'],
      });
      const extractButton = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-actions__extract',
      );
      expect(extractButton).toBeTruthy();
    });

    it('renders the renamed title label', () => {
      const fixture = createWith({
        value: '{"a":1}',
        pathString: '$.x',
        extractCandidate,
        extractPath: ['x'],
      });
      const titleLabel = (fixture.nativeElement as HTMLElement).querySelector(
        '.decoded-title__label',
      );
      expect(titleLabel?.textContent?.trim()).toBe('Inspect string value');
    });

    it('renders the shared extract button label text', () => {
      const fixture = createWith({
        value: '{"a":1}',
        pathString: '$.x',
        extractCandidate,
        extractPath: ['x'],
      });
      const extractButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__extract',
      );
      expect(extractButton).toBeTruthy();
      expect(extractButton?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
        'Extract embedded JSON',
      );
    });

    it('closes with an extract result when the extract button is clicked', () => {
      const fixture = createWith({
        value: '{"a":1}',
        pathString: '$.x',
        extractCandidate,
        extractPath: ['x'],
      });
      const extractButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__extract',
      );
      expect(extractButton).toBeTruthy();
      extractButton!.click();
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ kind: 'extract' });
    });
  });

  describe('close', () => {
    it('closes via MatDialogRef when the close button is clicked', () => {
      const fixture = createWith({ value: 'a', pathString: '$.x' });
      const closeBtn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__close',
      );
      expect(closeBtn).toBeTruthy();
      closeBtn!.click();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('mangling decode toggle', () => {
    const MANGLED_RESPONSE =
      '200 OK??Pragma: no-cache' +
      '??Strict-Transport-Security: max-age=63072000' +
      '??x-ms-request-id: e4786c1a-d489-4a6e-99ac-0d91ffb2711b' +
      '??Cache-Control: no-cache??Content-Type: application/json' +
      '????{"organizationId":"e674a4a6","note":"body has ??token=abc embedded"}';

    function toggleElement(fixture: ReturnType<typeof createWith>) {
      return (fixture.nativeElement as HTMLElement).querySelector('.decoded-sub-header__toggle');
    }

    function lineTexts(fixture: ReturnType<typeof createWith>): string[] {
      return Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.decoded-line__text'),
      ).map((node) => node.textContent ?? '');
    }

    it('does not render the toggle when the heuristic returns kind="none"', () => {
      const fixture = createWith({ value: 'plain prose, no framing', pathString: '$.x' });
      expect(toggleElement(fixture)).toBeNull();
    });

    it('renders the toggle in the off state when the heuristic fires', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const toggle = toggleElement(fixture);
      expect(toggle).toBeTruthy();
      expect(fixture.componentInstance.decoded()).toBeFalse();
      // Default raw mode: body still rendered as one line containing the raw ?? framing.
      expect(lineTexts(fixture).length).toBe(1);
      expect(lineTexts(fixture)[0]).toContain('200 OK??Pragma: no-cache');
    });

    it('exposes the documented accessible name on the toggle', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const toggle = toggleElement(fixture);
      expect(toggle?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
        'Show "??" as line breaks',
      );
    });

    it('re-renders multi-line when the toggle is flipped on', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const cmp = fixture.componentInstance;
      cmp.toggleDecoded(true);
      fixture.detectChanges();
      const texts = lineTexts(fixture);
      // Expect at least the status line, several header lines, a blank, and the body line.
      expect(texts.length).toBeGreaterThan(5);
      expect(texts[0]).toBe('200 OK');
      expect(texts).toContain('Pragma: no-cache');
      // Body is preserved verbatim (the embedded `??token=abc` survives).
      const bodyLine = texts.find((line) => line.includes('organizationId'));
      expect(bodyLine).toBeTruthy();
      expect(bodyLine).toContain('??token=abc');
    });

    it('Copy button mirrors the toggle: raw when off, decoded when on', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const cmp = fixture.componentInstance;
      const rawCopy = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__copy',
      );
      expect(rawCopy).toBeTruthy();
      // Toggle off (default): Copy writes the raw ??-mangled string verbatim.
      rawCopy!.click();
      expect(copyWithToast).toHaveBeenCalledTimes(1);
      expect(copyWithToast.calls.mostRecent().args[0]).toBe(MANGLED_RESPONSE);

      cmp.toggleDecoded(true);
      fixture.detectChanges();
      const decodedCopy = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__copy',
      );
      // Toggle on: Copy writes the CRLF-decoded form (what the user is seeing).
      decodedCopy!.click();
      expect(copyWithToast.calls.count()).toBe(2);
      const written = copyWithToast.calls.mostRecent().args[0] as string;
      expect(written).not.toBe(MANGLED_RESPONSE);
      expect(written).toContain('200 OK\r\n');
      expect(written).toContain('Pragma: no-cache\r\n');
      // Body separator + body preservation (verifies displayValue, not just any decoded form).
      expect(written).toContain('\r\n\r\n{"organizationId":"e674a4a6"');
      expect(written).toContain('??token=abc');
    });

    it('shows the Apply button only in decoded mode, closes with applyDecoded, announces and logs', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const cmp = fixture.componentInstance;
      // Off by default -> button absent.
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('.decoded-actions__apply'),
      ).toBeNull();

      cmp.toggleDecoded(true);
      fixture.detectChanges();
      // Reset the toggle-flip telemetry call so we can isolate the apply log below.
      loggerEvent.calls.reset();
      liveAnnounce.calls.reset();

      const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.decoded-actions__apply',
      );
      expect(btn).toBeTruthy();
      expect(btn?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
        'Replace ?? with line breaks',
      );
      btn!.click();

      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith({ kind: 'applyDecoded' });
      expect(liveAnnounce).toHaveBeenCalledTimes(1);
      expect(liveAnnounce.calls.mostRecent().args[0]).toBe('Applying decoded value to source.');
      const applyCalls = loggerEvent.calls
        .allArgs()
        .filter((args) => args[0] === 'tree.decoded.apply');
      expect(applyCalls.length).toBe(1);
      expect(applyCalls[0]?.[1]).toEqual({ manglingKind: 'httpFraming' });
    });

    it('announces the new state via LiveAnnouncer on every flip', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const cmp = fixture.componentInstance;
      cmp.toggleDecoded(true);
      cmp.toggleDecoded(false);
      expect(liveAnnounce).toHaveBeenCalledTimes(2);
      expect(liveAnnounce.calls.argsFor(0)[0]).toBe('Showing "??" markers as line breaks.');
      expect(liveAnnounce.calls.argsFor(1)[0]).toBe('Showing raw value.');
    });

    it('emits tree.decoded.manglingToggle with the post-flip "to" prop on every flip', () => {
      const fixture = createWith({ value: MANGLED_RESPONSE, pathString: '$.x' });
      const cmp = fixture.componentInstance;
      cmp.toggleDecoded(true);
      cmp.toggleDecoded(false);
      const calls = loggerEvent.calls
        .allArgs()
        .filter((args) => args[0] === 'tree.decoded.manglingToggle');
      expect(calls.length).toBe(2);
      expect(calls[0]?.[1]).toEqual({ to: 'decoded' });
      expect(calls[1]?.[1]).toEqual({ to: 'raw' });
    });
  });
});
