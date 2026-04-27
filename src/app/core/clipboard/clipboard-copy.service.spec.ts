import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ClipboardCopyService } from './clipboard-copy.service';

describe('ClipboardCopyService', () => {
  let service: ClipboardCopyService;
  let snackOpen: jasmine.Spy;
  let originalDescriptor: PropertyDescriptor | undefined;

  function setClipboard(value: { writeText?: jasmine.Spy } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value
    });
  }

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    snackOpen = jasmine.createSpy('open');
    TestBed.configureTestingModule({
      providers: [
        ClipboardCopyService,
        { provide: MatSnackBar, useValue: { open: snackOpen } }
      ]
    });
    service = TestBed.inject(ClipboardCopyService);
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalDescriptor);
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: undefined
      });
    }
  });

  const messages = {
    success: 'Copied!',
    failed: 'Could not copy.',
    unsupported: 'Copy is not supported in this browser.'
  };

  it('opens the unsupported snackbar when navigator.clipboard is missing', () => {
    setClipboard(undefined);
    service.copyWithToast('hello', messages);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.unsupported);
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 4000 });
  });

  it('opens the unsupported snackbar when writeText is missing on the clipboard', () => {
    setClipboard({});
    service.copyWithToast('hello', messages);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.unsupported);
  });

  it('writes text and opens the success snackbar when writeText resolves', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    setClipboard({ writeText });
    service.copyWithToast('hello', messages);
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.success);
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 3000 });
  });

  it('opens the failure snackbar when writeText rejects', async () => {
    const writeText = jasmine
      .createSpy('writeText')
      .and.rejectWith(new Error('denied'));
    setClipboard({ writeText });
    service.copyWithToast('hello', messages);
    await Promise.resolve();
    await Promise.resolve();
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.calls.mostRecent().args[0]).toBe(messages.failed);
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 4000 });
  });

  it('honors custom durations when provided', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    setClipboard({ writeText });
    service.copyWithToast('hello', messages, {
      successDurationMs: 1234,
      failedDurationMs: 5678,
      unsupportedDurationMs: 9012
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 1234 });
  });

  it('honors custom unsupportedDurationMs when clipboard is missing', () => {
    setClipboard(undefined);
    service.copyWithToast('hello', messages, { unsupportedDurationMs: 7777 });
    expect(snackOpen.calls.mostRecent().args[2]).toEqual({ duration: 7777 });
  });
});
