import { TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ClipboardCopyService } from './clipboard-copy.service';

describe('ClipboardCopyService', () => {
  let service: ClipboardCopyService;
  let snackOpen: jasmine.Spy;
  let originalDescriptor: PropertyDescriptor | undefined;

  function setClipboard(value: { writeText?: jasmine.Spy } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value,
    });
  }

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    snackOpen = jasmine.createSpy('open');
    TestBed.configureTestingModule({
      providers: [ClipboardCopyService, { provide: MatSnackBar, useValue: { open: snackOpen } }],
    });
    service = TestBed.inject(ClipboardCopyService);
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalDescriptor);
    } else {
      // navigator.clipboard lives on Navigator.prototype in real Chrome; if
      // there was no own-property before this spec, restore that state by
      // deleting the override rather than masking the prototype with undefined.
      delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
    }
  });

  const messages = {
    success: 'Copied!',
    failed: 'Could not copy.',
    unsupported: 'Copy is not supported in this browser.',
  };

  it('opens the unsupported snackbar and resolves false when navigator.clipboard is missing', fakeAsync(() => {
    setClipboard(undefined);
    let result: boolean | undefined;
    void service.copyWithToast('hello', messages).then((r) => (result = r));
    flushMicrotasks();
    expect(result).toBeFalse();
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.unsupported);
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 4000 });
  }));

  it('opens the unsupported snackbar when writeText is missing on the clipboard', fakeAsync(() => {
    setClipboard({});
    let result: boolean | undefined;
    void service.copyWithToast('hello', messages).then((r) => (result = r));
    flushMicrotasks();
    expect(result).toBeFalse();
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.unsupported);
  }));

  it('writes text, passes the Dismiss action label, and resolves true on success', fakeAsync(() => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    setClipboard({ writeText });
    let result: boolean | undefined;
    void service.copyWithToast('hello', messages).then((r) => (result = r));
    flushMicrotasks();
    expect(result).toBeTrue();
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.success);
    expect(snackOpen.calls.mostRecent().args[1]).toBe('Dismiss');
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 3000 });
  }));

  it('opens the failure snackbar and resolves false when writeText rejects', fakeAsync(() => {
    const writeText = jasmine.createSpy('writeText').and.rejectWith(new Error('denied'));
    setClipboard({ writeText });
    let result: boolean | undefined;
    void service.copyWithToast('hello', messages).then((r) => (result = r));
    flushMicrotasks();
    expect(result).toBeFalse();
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.failed);
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 4000 });
  }));

  it('honors custom durations when provided', fakeAsync(() => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    setClipboard({ writeText });
    void service.copyWithToast('hello', messages, {
      successDurationMs: 1234,
      failedDurationMs: 5678,
      unsupportedDurationMs: 9012,
    });
    flushMicrotasks();
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 1234 });
  }));

  it('honors custom unsupportedDurationMs when clipboard is missing', fakeAsync(() => {
    setClipboard(undefined);
    void service.copyWithToast('hello', messages, { unsupportedDurationMs: 7777 });
    flushMicrotasks();
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 7777 });
  }));
});
