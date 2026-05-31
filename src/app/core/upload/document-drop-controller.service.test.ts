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
}

function makeDragEvent(type: string, init: DragEventInit = {}): DragEvent {
  const types = init.types ?? ['Files'];
  const files = init.files ?? [];
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: {
      types,
      files,
      items: files.map(() => ({ kind: 'file' })),
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

  it('forwards drops to a registered handler and skips the snackbar', () => {
    const handler = vi.fn();
    controller.registerEditorHandler(handler);
    const file = makeFile();

    document.dispatchEvent(makeDragEvent('dragenter', { files: [file] }));
    document.dispatchEvent(makeDragEvent('drop', { files: [file] }));

    expect(handler).toHaveBeenCalledTimes(1);
    const passed = handler.mock.lastCall![0] as readonly File[];
    expect(passed.length).toBe(1);
    expect(passed[0]).toBe(file);
    expect(snackOpen).not.toHaveBeenCalled();
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

  it('disposes a registered handler so subsequent drops fall back to the snackbar', () => {
    const handler = vi.fn();
    const dispose = controller.registerEditorHandler(handler);
    dispose();

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    expect(handler).not.toHaveBeenCalled();
    expect(snackOpen).toHaveBeenCalledTimes(1);
  });

  it('replaces the active handler when register is called twice', () => {
    const warn = vi.spyOn(console, 'warn');
    const first = vi.fn();
    const second = vi.fn();
    controller.registerEditorHandler(first);
    controller.registerEditorHandler(second);

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('ignores a stale dispose so it does not clobber the new handler', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = controller.registerEditorHandler(first);
    controller.registerEditorHandler(second);

    // The first owner runs its dispose late; it must NOT clear the
    // active handler because someone else now owns it.
    disposeFirst();

    document.dispatchEvent(makeDragEvent('drop', { files: [makeFile()] }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(snackOpen).not.toHaveBeenCalled();
  });
});
