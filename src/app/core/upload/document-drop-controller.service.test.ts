import { TestBed } from '@angular/core/testing';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { type Mock, type Mocked } from 'vitest';
import { DocumentDropController } from './document-drop-controller.service';

interface DragEventInit {
  types?: readonly string[];
  files?: readonly File[];
  relatedTarget?: EventTarget | null;
  items?: readonly Partial<DataTransferItem>[];
}

function makeDragEvent(type: string, init: DragEventInit = {}): DragEvent {
  const types = init.types ?? ['Files'];
  const files = init.files ?? [];
  const items =
    init.items ?? files.map(() => ({ kind: 'file' as const }) as Partial<DataTransferItem>);
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      types,
      files,
      items,
    },
  });
  if (init.relatedTarget !== undefined) {
    Object.defineProperty(event, 'relatedTarget', {
      configurable: true,
      value: init.relatedTarget,
    });
  }
  return event;
}

function makeFile(name = 'sample.json', body = '{}'): File {
  return new File([body], name, { type: 'application/json' });
}

function makeFakeHandle(name = 'sample.json'): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name,
  } as unknown as FileSystemFileHandle;
}

/**
 * Microtask-flush helper. The async drop dispatcher awaits
 * `Promise.all(items.map(...))` before invoking the handler; specs that
 * inspect handler invocation need to drain the microtask queue first.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('DocumentDropController', () => {
  let controller: DocumentDropController;
  let snackOpen: Mock;
  let actionSubject: Subject<void>;
  let snackRef: Mocked<MatSnackBarRef<TextOnlySnackBar>>;
  let navigateByUrl: Mock;
  let originalHidden: PropertyDescriptor | undefined;

  beforeEach(() => {
    actionSubject = new Subject<void>();
    snackRef = { onAction: vi.fn(), dismiss: vi.fn() } as unknown as Mocked<
      MatSnackBarRef<TextOnlySnackBar>
    >;
    snackRef.onAction.mockReturnValue(actionSubject.asObservable());
    snackOpen = vi.fn().mockReturnValue(snackRef);
    navigateByUrl = vi.fn().mockResolvedValue(true);
    originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');

    TestBed.configureTestingModule({
      providers: [
        DocumentDropController,
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    controller = TestBed.inject(DocumentDropController);
  });

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(Document.prototype, 'hidden', originalHidden);
    }
  });

  it('starts with dropActive=false', () => {
    expect(controller.dropActive()).toBe(false);
  });

  it('flips dropActive on dragenter and clears it on drop', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);
    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    expect(controller.dropActive()).toBe(false);
  });

  it('forwards drops to a registered handler and skips the snackbar', async () => {
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const file = makeFile();

    document.dispatchEvent(makeDragEvent('dragenter', { files: [file] }));
    document.dispatchEvent(makeDragEvent('drop', { files: [file] }));
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    const callArgs = handler.mock.lastCall as readonly unknown[];
    const passedFiles = callArgs[0] as readonly File[];
    const passedHandles = callArgs[1] as readonly (FileSystemFileHandle | null)[];
    expect(passedFiles.length).toBe(1);
    expect(passedFiles[0]).toBe(file);
    expect(passedHandles.length).toBe(1);
    // No getAsFileSystemHandle on the item stub -> null slot.
    expect(passedHandles[0]).toBeNull();
    expect(snackOpen).not.toHaveBeenCalled();
  });

  it('populates handles[i] when DataTransferItem.getAsFileSystemHandle resolves to a file handle', async () => {
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const file = makeFile();
    const handle = makeFakeHandle('sample.json');
    const item: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockResolvedValue(handle),
    };

    document.dispatchEvent(makeDragEvent('drop', { files: [file], items: [item] }));
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    const passedHandles = handler.mock.lastCall![1] as readonly (FileSystemFileHandle | null)[];
    expect(passedHandles[0]).toBe(handle);
  });

  it('writes null per item when getAsFileSystemHandle rejects (per-item, not whole-drop)', async () => {
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const fileA = makeFile('a.json');
    const fileB = makeFile('b.json');
    const handleA = makeFakeHandle('a.json');
    const itemA: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockResolvedValue(handleA),
    };
    const itemB: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockRejectedValue(new Error('per-item failure')),
    };

    document.dispatchEvent(makeDragEvent('drop', { files: [fileA, fileB], items: [itemA, itemB] }));
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    const passedFiles = handler.mock.lastCall![0] as readonly File[];
    const passedHandles = handler.mock.lastCall![1] as readonly (FileSystemFileHandle | null)[];
    expect(passedFiles.length).toBe(2);
    expect(passedHandles.length).toBe(2);
    expect(passedHandles[0]).toBe(handleA);
    expect(passedHandles[1]).toBeNull();
  });

  it('writes null when the handle kind is "directory" (not "file")', async () => {
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const file = makeFile();
    const directoryHandle = {
      kind: 'directory' as const,
      name: 'someDir',
    } as unknown as FileSystemHandle;
    const item: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockResolvedValue(directoryHandle),
    };

    document.dispatchEvent(makeDragEvent('drop', { files: [file], items: [item] }));
    await flushMicrotasks();

    const passedHandles = handler.mock.lastCall![1] as readonly (FileSystemFileHandle | null)[];
    expect(passedHandles[0]).toBeNull();
  });

  it('flips dropActive=false synchronously even when handle resolution is in flight', () => {
    let resolveHandle: (value: FileSystemFileHandle | null) => void = () => {};
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const file = makeFile();
    const pendingPromise = new Promise<FileSystemFileHandle | null>((resolve) => {
      resolveHandle = resolve;
    });
    const item: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockReturnValue(pendingPromise),
    };

    document.dispatchEvent(makeDragEvent('dragenter', { files: [file], items: [item] }));
    document.dispatchEvent(makeDragEvent('drop', { files: [file], items: [item] }));

    // dropActive flips false synchronously inside onDrop, before the
    // per-item getAsFileSystemHandle promise resolves.
    expect(controller.dropActive()).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    resolveHandle(null);
  });

  it('opens a snackbar with a Go-to-editor action when no handler is registered', () => {
    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    expect(snackOpen).toHaveBeenCalledTimes(1);
    const args = snackOpen.mock.lastCall!;
    expect(args[0]).toContain('editor');
    expect(args[1]).toContain('editor');

    actionSubject.next();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('pairs handles to files when items contains interspersed non-file entries', async () => {
    // dataTransfer.items can include non-'file' entries (e.g.,
    // text/uri-list when a drag carries both a file and a URL).
    // dataTransfer.files contains only the File subset. The handler
    // must receive handles aligned to files by walking files and
    // pulling handles from the 'file'-kind items by file-index.
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const fileA = makeFile('a.json', '{"a":1}');
    const fileB = makeFile('b.json', '{"b":2}');
    const handleA = makeFakeHandle('a.json');
    const handleB = makeFakeHandle('b.json');
    const fileItemA: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockResolvedValue(handleA),
    };
    const urlItem: Partial<DataTransferItem> = {
      kind: 'string',
      // No getAsFileSystemHandle on a non-file item.
    };
    const fileItemB: Partial<DataTransferItem> = {
      kind: 'file',
      getAsFileSystemHandle: vi.fn().mockResolvedValue(handleB),
    };

    document.dispatchEvent(
      makeDragEvent('drop', {
        files: [fileA, fileB],
        items: [fileItemA, urlItem, fileItemB],
      }),
    );
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    const passedFiles = handler.mock.lastCall![0] as readonly File[];
    const passedHandles = handler.mock.lastCall![1] as readonly (FileSystemFileHandle | null)[];
    // handles is aligned to files, not to items.
    expect(passedFiles).toEqual([fileA, fileB]);
    expect(passedHandles).toHaveLength(2);
    expect(passedHandles[0]).toBe(handleA);
    expect(passedHandles[1]).toBe(handleB);
  });

  it('routes an async handler rejection through console.warn instead of unhandled-promise', async () => {
    const warn = vi.spyOn(console, 'warn');
    const handler = vi.fn().mockRejectedValue(new Error('handler boom'));
    controller.registerEditorHandler(handler);

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    const calls = warn.mock.calls.filter(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('drop dispatch failed'),
    );
    expect(calls.length).toBe(1);
  });

  it('always calls preventDefault on dragover with files', () => {
    const event = makeDragEvent('dragover', { files: [makeFile()] });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('ignores drags that do not carry files', () => {
    const event = makeDragEvent('dragover', { types: ['text/plain'], files: [] });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);
    expect(preventDefault).not.toHaveBeenCalled();

    document.dispatchEvent(makeDragEvent('dragenter', { types: ['text/plain'], files: [] }));
    expect(controller.dropActive()).toBe(false);
  });

  it('resets the counter when dragleave has a null relatedTarget', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    document.dispatchEvent(makeDragEvent('dragenter'));
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);

    document.dispatchEvent(makeDragEvent('dragleave', { relatedTarget: null }));
    expect(controller.dropActive()).toBe(false);
  });

  it('keeps the overlay visible while the counter stays positive', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);

    document.dispatchEvent(makeDragEvent('dragleave', { relatedTarget: document.body }));
    expect(controller.dropActive()).toBe(true);
  });

  it('resets dropActive when Escape is pressed', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(controller.dropActive()).toBe(false);
  });

  it('resets dropActive when the window blurs', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(controller.dropActive()).toBe(false);
  });

  it('resets dropActive when the document is hidden', () => {
    document.dispatchEvent(makeDragEvent('dragenter'));
    expect(controller.dropActive()).toBe(true);

    Object.defineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(controller.dropActive()).toBe(false);
  });

  it('disposes a registered handler so subsequent drops fall back to the snackbar', async () => {
    const handler = vi.fn();
    const dispose = controller.registerEditorHandler(handler);
    dispose();

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    await flushMicrotasks();
    expect(handler).not.toHaveBeenCalled();
    expect(snackOpen).toHaveBeenCalledTimes(1);
  });

  it('replaces the active handler when register is called twice', async () => {
    const warn = vi.spyOn(console, 'warn');
    const first = vi.fn();
    const second = vi.fn();
    controller.registerEditorHandler(first);
    controller.registerEditorHandler(second);

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    await flushMicrotasks();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a stale dispose so it does not clobber the new handler', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = controller.registerEditorHandler(first);
    controller.registerEditorHandler(second);

    // The first owner runs its dispose late; it must NOT clear the
    // active handler because someone else now owns it.
    disposeFirst();

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    await flushMicrotasks();
    expect(second).toHaveBeenCalledTimes(1);
    expect(snackOpen).not.toHaveBeenCalled();
  });
});
