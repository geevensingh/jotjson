import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { type MockInstance } from 'vitest';
import { ClipboardCopyService } from './clipboard-copy.service';

describe('ClipboardCopyService', () => {
  let service: ClipboardCopyService;
  let snackOpen: MockInstance;
  let originalDescriptor: PropertyDescriptor | undefined;

  function setClipboard(value: { writeText?: MockInstance } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value,
    });
  }

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    snackOpen = vi.fn();
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

  it('opens the unsupported snackbar and resolves false when navigator.clipboard is missing', async () => {
    setClipboard(undefined);
    const result = await service.copyWithToast('hello', messages);
    expect(result).toBe(false);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.mock.lastCall![0]).toBe(messages.unsupported);
    expect(snackOpen.mock.lastCall![2]).toEqual({ duration: 4000 });
  });

  it('opens the unsupported snackbar when writeText is missing on the clipboard', async () => {
    setClipboard({});
    const result = await service.copyWithToast('hello', messages);
    expect(result).toBe(false);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.mock.lastCall![0]).toBe(messages.unsupported);
  });

  it('writes text, passes the Dismiss action label, and resolves true on success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const result = await service.copyWithToast('hello', messages);
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.mock.lastCall![0]).toBe(messages.success);
    expect(snackOpen.mock.lastCall![1]).toBe('Dismiss');
    expect(snackOpen.mock.lastCall![2]).toEqual({ duration: 3000 });
  });

  it('opens the failure snackbar and resolves false when writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    const result = await service.copyWithToast('hello', messages);
    expect(result).toBe(false);
    expect(snackOpen).toHaveBeenCalledTimes(1);
    expect(snackOpen.mock.lastCall![0]).toBe(messages.failed);
    expect(snackOpen.mock.lastCall![2]).toEqual({ duration: 4000 });
  });

  it('honors custom durations when provided', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await service.copyWithToast('hello', messages, {
      successDurationMs: 1234,
      failedDurationMs: 5678,
      unsupportedDurationMs: 9012,
    });
    expect(snackOpen.mock.lastCall![2]).toEqual({ duration: 1234 });
  });

  it('honors custom unsupportedDurationMs when clipboard is missing', async () => {
    setClipboard(undefined);
    await service.copyWithToast('hello', messages, { unsupportedDurationMs: 7777 });
    expect(snackOpen.mock.lastCall![2]).toEqual({ duration: 7777 });
  });
});
