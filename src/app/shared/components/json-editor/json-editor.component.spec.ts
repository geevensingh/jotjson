import { ComponentFixture, TestBed } from '@angular/core/testing';
import type * as MonacoNS from 'monaco-editor';
import { provideFakeAuth } from '../../../../testing/auth.testing';
import { installMinimalMonacoStub, restoreMonacoStub } from '../../../../testing/monaco.testing';
import type { JsonParseError } from '../../../core/json/json-parser.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { JsonEditorComponent } from './json-editor.component';
import { __resetMonacoLoaderForTesting, __setMonacoLoaderPromiseForTesting } from './monaco-loader';

const STORAGE_KEY = 'jotjson.preferences.v1';

interface FakeRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface FakeModel {
  id: string;
  getValue: () => string;
  getValueInRange: (range: FakeRange) => string;
  getOffsetAt: jasmine.Spy<(pos: { lineNumber: number; column: number }) => number>;
  getPositionAt: jasmine.Spy<(offset: number) => { lineNumber: number; column: number }>;
}

interface FakeEditor {
  getValue: jasmine.Spy<() => string>;
  setValue: jasmine.Spy<(v: string) => void>;
  getModel: jasmine.Spy<() => FakeModel | null>;
  onDidChangeModelContent: jasmine.Spy;
  onDidChangeCursorPosition: jasmine.Spy;
  onDidPaste: jasmine.Spy;
  updateOptions: jasmine.Spy;
  dispose: jasmine.Spy;
  executeEdits: jasmine.Spy;
  trigger: jasmine.Spy;
  layout: jasmine.Spy;
  setSelection: jasmine.Spy;
  revealRangeInCenterIfOutsideViewport: jasmine.Spy;
}

interface FakeSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface FakeMonaco {
  editor: {
    create: jasmine.Spy<(...args: unknown[]) => FakeEditor>;
    defineTheme: jasmine.Spy;
    setTheme: jasmine.Spy;
    setModelMarkers: jasmine.Spy;
  };
  json: { jsonDefaults: { setDiagnosticsOptions: jasmine.Spy } };
  MarkerSeverity: { Error: number };
  Range: new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ) => FakeRange;
  Selection: new (
    selectionStartLineNumber: number,
    selectionStartColumn: number,
    positionLineNumber: number,
    positionColumn: number,
  ) => FakeSelection;
  __selectionConstructorCalls: Array<[number, number, number, number]>;
}

interface FakeResizeObserver {
  observe: jasmine.Spy;
  unobserve: jasmine.Spy;
  disconnect: jasmine.Spy;
}

interface MonacoRequireStub {
  config: jasmine.Spy<(configuration: { paths: Record<string, string> }) => void>;
  (modules: string[], onReady: () => void): void;
}

const FAKE_MARKER_ERROR_SEVERITY = 8;

function makeFakeEditor(initial: string): FakeEditor {
  let current = initial;
  const undoStack: string[] = [];
  const modelContentHandlers: Array<() => void> = [];
  const toOffset = (line: number, column: number): number => {
    const lines = current.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      off += lines[i].length + 1;
    }
    return off + (column - 1);
  };
  const toPosition = (offset: number): { lineNumber: number; column: number } => {
    const boundedOffset = Math.max(0, Math.min(offset, current.length));
    const prefix = current.substring(0, boundedOffset);
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return {
      lineNumber: lines.length,
      column: lastLine.length + 1,
    };
  };
  const emitModelContentChange = (): void => {
    for (const handler of modelContentHandlers) {
      handler();
    }
  };
  const model: FakeModel = {
    id: 'fake-model',
    getValue: () => current,
    getValueInRange: (range) => {
      const start = toOffset(range.startLineNumber, range.startColumn);
      const end = toOffset(range.endLineNumber, range.endColumn);
      return current.substring(start, end);
    },
    getOffsetAt: jasmine
      .createSpy('getOffsetAt')
      .and.callFake((position: { lineNumber: number; column: number }) =>
        toOffset(position.lineNumber, position.column),
      ),
    getPositionAt: jasmine
      .createSpy('getPositionAt')
      .and.callFake((offset: number) => toPosition(offset)),
  };
  return {
    getValue: jasmine.createSpy('getValue').and.callFake(() => current),
    setValue: jasmine.createSpy('setValue').and.callFake((v: string) => {
      current = v;
      undoStack.length = 0;
      emitModelContentChange();
    }),
    getModel: jasmine.createSpy('getModel').and.returnValue(model),
    onDidChangeModelContent: jasmine
      .createSpy('onDidChangeModelContent')
      .and.callFake((handler: () => void) => {
        modelContentHandlers.push(handler);
        return { dispose: () => undefined };
      }),
    onDidChangeCursorPosition: jasmine.createSpy('onDidChangeCursorPosition').and.returnValue({
      dispose: () => undefined,
    }),
    onDidPaste: jasmine.createSpy('onDidPaste').and.returnValue({
      dispose: () => undefined,
    }),
    updateOptions: jasmine.createSpy('updateOptions'),
    dispose: jasmine.createSpy('dispose'),
    executeEdits: jasmine.createSpy('executeEdits').and.callFake(
      (
        _source: string,
        edits: Array<{
          range: FakeRange;
          text: string;
          forceMoveMarkers?: boolean;
        }>,
      ) => {
        undoStack.push(current);
        for (const edit of edits) {
          const start = toOffset(edit.range.startLineNumber, edit.range.startColumn);
          const end = toOffset(edit.range.endLineNumber, edit.range.endColumn);
          current = current.substring(0, start) + edit.text + current.substring(end);
        }
        emitModelContentChange();
        return true;
      },
    ),
    trigger: jasmine
      .createSpy('trigger')
      .and.callFake((_source: string, handlerId: string, _payload: unknown) => {
        if (handlerId !== 'undo') {
          return;
        }
        const previousValue = undoStack.pop();
        if (previousValue === undefined) {
          return;
        }
        current = previousValue;
        emitModelContentChange();
      }),
    layout: jasmine.createSpy('layout'),
    setSelection: jasmine.createSpy('setSelection'),
    revealRangeInCenterIfOutsideViewport: jasmine.createSpy('revealRangeInCenterIfOutsideViewport'),
  };
}

function makeFakeMonaco(editor: FakeEditor): FakeMonaco {
  const selectionCalls: Array<[number, number, number, number]> = [];
  function FakeRangeCtor(
    this: FakeRange,
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
  ): FakeRange {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
    return this;
  }
  function FakeSelectionCtor(
    this: FakeSelection,
    selectionStartLineNumber: number,
    selectionStartColumn: number,
    positionLineNumber: number,
    positionColumn: number,
  ): FakeSelection {
    selectionCalls.push([
      selectionStartLineNumber,
      selectionStartColumn,
      positionLineNumber,
      positionColumn,
    ]);
    // Selection's normalized start/end fields - smaller (line, col) is
    // start, larger is end - regardless of which corner the caller
    // passed first. The reversed-Selection trick (passing end coords
    // first) leaves these the same; only the active cursor differs.
    const startLineFirst =
      selectionStartLineNumber < positionLineNumber ||
      (selectionStartLineNumber === positionLineNumber && selectionStartColumn <= positionColumn);
    this.startLineNumber = startLineFirst ? selectionStartLineNumber : positionLineNumber;
    this.startColumn = startLineFirst ? selectionStartColumn : positionColumn;
    this.endLineNumber = startLineFirst ? positionLineNumber : selectionStartLineNumber;
    this.endColumn = startLineFirst ? positionColumn : selectionStartColumn;
    return this;
  }
  return {
    editor: {
      create: jasmine.createSpy('create').and.returnValue(editor),
      defineTheme: jasmine.createSpy('defineTheme'),
      setTheme: jasmine.createSpy('setTheme'),
      setModelMarkers: jasmine.createSpy('setModelMarkers'),
    },
    json: { jsonDefaults: { setDiagnosticsOptions: jasmine.createSpy('setDiagnosticsOptions') } },
    MarkerSeverity: { Error: FAKE_MARKER_ERROR_SEVERITY },
    Range: FakeRangeCtor as unknown as FakeMonaco['Range'],
    Selection: FakeSelectionCtor as unknown as FakeMonaco['Selection'],
    __selectionConstructorCalls: selectionCalls,
  };
}

describe('JsonEditorComponent', () => {
  let fixture: ComponentFixture<JsonEditorComponent>;
  let editor: FakeEditor;
  let monaco: FakeMonaco;
  let resizeObserver: FakeResizeObserver;
  let logger: jasmine.SpyObj<LoggerService>;
  let originalMonaco: unknown;
  let originalResizeObserver: typeof window.ResizeObserver | undefined;
  let minimalMonacoInstalled = false;

  async function createFixtureWithoutSettling(
    initial = '{"a":1}',
  ): Promise<ComponentFixture<JsonEditorComponent>> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonEditorComponent],
      providers: [...provideFakeAuth(), { provide: LoggerService, useValue: logger }],
    }).compileComponents();
    const nextFixture = TestBed.createComponent(JsonEditorComponent);
    nextFixture.componentRef.setInput('value', initial);
    nextFixture.detectChanges();
    return nextFixture;
  }

  async function create(initial = '{"a":1}'): Promise<JsonEditorComponent> {
    fixture = await createFixtureWithoutSettling(initial);
    // ngAfterViewInit awaits loadMonaco() (resolved synchronously since
    // window.monaco is preset). Let microtasks settle so the editor mounts.
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);

    editor = makeFakeEditor('{"a":1}');
    monaco = makeFakeMonaco(editor);
    logger = jasmine.createSpyObj<LoggerService>('LoggerService', ['error', 'event']);
    minimalMonacoInstalled = false;

    originalMonaco = (window as unknown as { monaco?: unknown }).monaco;
    (window as unknown as { monaco: FakeMonaco }).monaco = monaco;

    originalResizeObserver = window.ResizeObserver;
    resizeObserver = {
      observe: jasmine.createSpy('observe'),
      unobserve: jasmine.createSpy('unobserve'),
      disconnect: jasmine.createSpy('disconnect'),
    };
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = function () {
      return resizeObserver;
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    if (minimalMonacoInstalled) {
      restoreMonacoStub();
      minimalMonacoInstalled = false;
    }
    __resetMonacoLoaderForTesting();
    if (originalMonaco === undefined) {
      delete (window as unknown as { monaco?: unknown }).monaco;
    } else {
      (window as unknown as { monaco: unknown }).monaco = originalMonaco;
    }
    if (originalResizeObserver) {
      window.ResizeObserver = originalResizeObserver;
    } else {
      delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    }
    localStorage.removeItem(STORAGE_KEY);
  });

  function installMonacoLoaderScriptPlaceholder(): void {
    const script = document.createElement('script');
    script.dataset['monacoLoader'] = 'true';
    document.head.appendChild(script);
  }

  function installRequireThatLoadsFakeMonaco(): void {
    const requireStub: MonacoRequireStub = Object.assign(
      (modules: string[], onReady: () => void) => {
        void modules;
        (window as unknown as { monaco: FakeMonaco }).monaco = monaco;
        onReady();
      },
      {
        config:
          jasmine.createSpy<(configuration: { paths: Record<string, string> }) => void>(
            'require.config',
          ),
      },
    );
    window.require = requireStub;
  }

  function installRequireThatLeavesMonacoUnavailable(): void {
    const requireStub: MonacoRequireStub = Object.assign(
      (modules: string[], onReady: () => void) => {
        void modules;
        onReady();
      },
      {
        config:
          jasmine.createSpy<(configuration: { paths: Record<string, string> }) => void>(
            'require.config',
          ),
      },
    );
    window.require = requireStub;
  }

  function expectMonacoLoadedNotEmitted(): void {
    const emitted = logger.event.calls
      .allArgs()
      .some(([messageId]) => messageId === 'monaco.loaded');
    expect(emitted).toBeFalse();
  }

  it('creates the Monaco editor on mount', async () => {
    await create();
    expect(monaco.editor.create).toHaveBeenCalledTimes(1);
  });

  it('emits monaco.loaded with load time when Monaco is loaded uncached', async () => {
    __resetMonacoLoaderForTesting();
    installMonacoLoaderScriptPlaceholder();
    installRequireThatLoadsFakeMonaco();
    await create();
    expect(logger.event).toHaveBeenCalledOnceWith('monaco.loaded', undefined, {
      loadTimeMs: jasmine.any(Number),
    });
    const measurements = logger.event.calls.mostRecent().args[2];
    if (!measurements) {
      fail('monaco.loaded measurements were not captured');
      return;
    }
    expect(measurements['loadTimeMs']).toBeGreaterThanOrEqual(0);
  });

  it('does not emit monaco.loaded when Monaco is already cached', async () => {
    delete (window as unknown as { monaco?: unknown }).monaco;
    installMinimalMonacoStub();
    minimalMonacoInstalled = true;
    await create();
    expectMonacoLoadedNotEmitted();
  });

  it('does not emit monaco.loaded when Monaco loading fails', async () => {
    __resetMonacoLoaderForTesting();
    installMonacoLoaderScriptPlaceholder();
    installRequireThatLeavesMonacoUnavailable();
    await create();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [messageId, cause] = logger.error.calls.mostRecent().args;
    expect(messageId).toBe('monaco.loadFailed');
    expect(cause).toEqual(jasmine.any(Error));
    expectMonacoLoadedNotEmitted();
  });

  it('disposes the Monaco editor instance on destroy', async () => {
    await create();
    expect(editor.dispose).not.toHaveBeenCalled();
    fixture.destroy();
    expect(editor.dispose).toHaveBeenCalledTimes(1);
  });

  it('disconnects the ResizeObserver on destroy', async () => {
    await create();
    expect(resizeObserver.observe).toHaveBeenCalledTimes(1);
    expect(resizeObserver.disconnect).not.toHaveBeenCalled();
    fixture.destroy();
    expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
  });

  // Regression for issue #98: if the fixture is destroyed while
  // ngAfterViewInit is suspended on `await loadMonaco()`, the
  // post-await body must not allocate Monaco or a ResizeObserver -
  // ngOnDestroy has already run past `editor`/`resizeObs` (still
  // undefined), so any creation here would leak as a zombie.
  it('does not create Monaco when fixture is destroyed before loadMonaco resolves', async () => {
    delete (window as unknown as { monaco?: unknown }).monaco;
    __resetMonacoLoaderForTesting();
    let resolveLoader!: (value: typeof MonacoNS) => void;
    const deferred = new Promise<typeof MonacoNS>((resolve) => {
      resolveLoader = resolve;
    });
    __setMonacoLoaderPromiseForTesting(deferred);

    fixture = await createFixtureWithoutSettling();
    const component = fixture.componentInstance;
    // ngAfterViewInit is now suspended on `await loadMonaco()`. Tear
    // the view down before resolving.
    fixture.destroy();

    // Resolve the loader so the post-await continuation runs.
    resolveLoader(monaco as unknown as typeof MonacoNS);
    await deferred;
    // Yield once more so the post-`if (destroyed) return` queued
    // microtasks (logger.event, runOutsideAngular setup, etc.) settle.
    await Promise.resolve();

    expect(monaco.editor.create).not.toHaveBeenCalled();
    expect(resizeObserver.observe).not.toHaveBeenCalled();
    expect(component.ready()).toBeFalse();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('pushes external value changes into the editor via setValue', async () => {
    await create('{"a":1}');
    editor.setValue.calls.reset();
    fixture.componentRef.setInput('value', '{"b":2}');
    fixture.detectChanges();
    expect(editor.setValue).toHaveBeenCalledTimes(1);
    expect(editor.setValue).toHaveBeenCalledWith('{"b":2}');
  });

  it('does not call setValue when the input matches the current editor value (no echo)', async () => {
    await create('{"a":1}');
    editor.setValue.calls.reset();
    // Re-set the input to the same value the (mock) editor reports.
    fixture.componentRef.setInput('value', '{"a":1}');
    fixture.detectChanges();
    expect(editor.setValue).not.toHaveBeenCalled();
  });

  it('publishes Monaco markers when the errors input changes', async () => {
    await create('{"a":1}');
    monaco.editor.setModelMarkers.calls.reset();

    const errs: JsonParseError[] = [
      { message: 'Unexpected token', offset: 5, length: 1, line: 2, column: 3 },
    ];
    fixture.componentRef.setInput('errors', errs);
    fixture.detectChanges();

    expect(monaco.editor.setModelMarkers).toHaveBeenCalledTimes(1);
    const args = monaco.editor.setModelMarkers.calls.mostRecent().args;
    expect(args[1]).toBe('jotjson');
    const markers = args[2] as Array<{
      severity: number;
      message: string;
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }>;
    expect(markers.length).toBe(1);
    expect(markers[0].severity).toBe(FAKE_MARKER_ERROR_SEVERITY);
    expect(markers[0].message).toBe('Unexpected token');
    expect(markers[0].startLineNumber).toBe(2);
    expect(markers[0].startColumn).toBe(3);
    expect(markers[0].endLineNumber).toBe(2);
    expect(markers[0].endColumn).toBe(4);
  });

  it('clears markers when errors input becomes empty', async () => {
    await create('{"a":1}');
    fixture.componentRef.setInput('errors', [
      { message: 'oops', offset: 0, length: 1, line: 1, column: 1 },
    ]);
    fixture.detectChanges();
    monaco.editor.setModelMarkers.calls.reset();
    fixture.componentRef.setInput('errors', []);
    fixture.detectChanges();
    expect(monaco.editor.setModelMarkers).toHaveBeenCalledTimes(1);
    expect(monaco.editor.setModelMarkers.calls.mostRecent().args[2]).toEqual([]);
  });

  describe('paste output', () => {
    interface PasteEvent {
      pastedText: string;
      postPasteContent: string;
      postPasteParses: boolean;
    }

    function firePasteIntoEmpty(component: JsonEditorComponent, text: string): PasteEvent[] {
      const events: PasteEvent[] = [];
      component.paste.subscribe((e) => events.push(e));
      // Simulate Monaco having already inserted the pasted text into the model
      // (onDidPaste fires AFTER the insertion). Single-line paste at (1,1).
      editor.setValue(text);
      const handler = editor.onDidPaste.calls.mostRecent().args[0] as (event: {
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        };
      }) => void;
      handler({
        range: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: text.length + 1,
        },
      });
      return events;
    }

    it('emits paste once with raw mixed text and postPasteParses=false', async () => {
      const component = await create('');
      const mixed = 'log line: hello world';
      const events = firePasteIntoEmpty(component, mixed);
      expect(events.length).toBe(1);
      expect(events[0].pastedText).toBe(mixed);
      expect(events[0].postPasteContent).toBe(mixed);
      expect(events[0].postPasteParses).toBeFalse();
      // No unescape rewrite expected for plain mixed text.
      expect(editor.executeEdits).not.toHaveBeenCalled();
    });

    it('emits paste once with the unescaped text when unescape rewrites the region', async () => {
      const component = await create('');
      const escaped = '{\\"a\\":1}';
      const events = firePasteIntoEmpty(component, escaped);
      expect(editor.executeEdits).toHaveBeenCalledTimes(1);
      expect(events.length).toBe(1);
      expect(events[0].pastedText).toBe('{"a":1}');
      expect(events[0].postPasteContent).toBe('{"a":1}');
      expect(events[0].postPasteParses).toBeTrue();
    });

    it('emits paste once with valid JSON and postPasteParses=true (no unescape)', async () => {
      const component = await create('');
      const events = firePasteIntoEmpty(component, '{"a":1}');
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(events.length).toBe(1);
      expect(events[0].pastedText).toBe('{"a":1}');
      expect(events[0].postPasteContent).toBe('{"a":1}');
      expect(events[0].postPasteParses).toBeTrue();
    });
  });

  describe('cursorPositionChange', () => {
    interface CursorEvent {
      line: number;
      column: number;
      offset: number;
    }

    function fireCursor(line: number, column: number): CursorEvent[] {
      const events: CursorEvent[] = [];
      fixture.componentInstance.cursorPositionChange.subscribe((e) => events.push(e));
      const handler = editor.onDidChangeCursorPosition.calls.mostRecent().args[0] as (event: {
        position: { lineNumber: number; column: number };
      }) => void;
      handler({ position: { lineNumber: line, column } });
      return events;
    }

    it('emits {line, column, offset} with offset computed from the model', async () => {
      await create('{"a":1}');
      const events = fireCursor(1, 4);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ line: 1, column: 4, offset: 3 });
      const model = editor.getModel() as FakeModel;
      expect(model.getOffsetAt).toHaveBeenCalledWith({ lineNumber: 1, column: 4 });
    });

    it('falls back to offset=0 when the model is null', async () => {
      await create('{"a":1}');
      // Simulate a teardown race where the model went away before the event.
      editor.getModel.and.returnValue(null);
      const events = fireCursor(2, 3);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ line: 2, column: 3, offset: 0 });
    });
  });

  describe('applyEdit and undo helpers', () => {
    it('splices text via executeEdits and preserves undo history', async () => {
      const component = await create('{"a":1}');

      expect(component.applyEdit(5, 6, '2', 'spec-apply-edit')).toBeTrue();
      expect(editor.getValue()).toBe('{"a":2}');
      expect(editor.executeEdits).toHaveBeenCalledTimes(1);
      expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);

      component.triggerUndo();
      expect(editor.getValue()).toBe('{"a":1}');
    });

    it('returns false when the editor is not yet ready', async () => {
      delete (window as unknown as { monaco?: unknown }).monaco;
      __resetMonacoLoaderForTesting();
      let resolveLoader!: (value: typeof MonacoNS) => void;
      const deferred = new Promise<typeof MonacoNS>((resolve) => {
        resolveLoader = resolve;
      });
      __setMonacoLoaderPromiseForTesting(deferred);

      const earlyFixture = await createFixtureWithoutSettling('{"a":1}');

      expect(earlyFixture.componentInstance.applyEdit(5, 6, '2', 'spec-apply-edit')).toBeFalse();
      expect(editor.executeEdits).not.toHaveBeenCalled();

      earlyFixture.destroy();
      resolveLoader(monaco as unknown as typeof MonacoNS);
      await deferred;
      await Promise.resolve();
    });

    it('returns false when the range length assertion fails', async () => {
      const component = await create('{"a":1}');

      expect(component.applyEdit(5, 99, '2', 'spec-apply-edit')).toBeFalse();
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(editor.getValue()).toBe('{"a":1}');
    });

    it('applies reverse edits with the same Monaco edit path', async () => {
      const component = await create('{"a":1}');

      expect(component.applyReverseEdit(5, 6, '2', 'spec-reverse-edit')).toBeTrue();
      expect(editor.getValue()).toBe('{"a":2}');
    });

    it('calls editor.trigger with the Monaco undo command', async () => {
      const component = await create('{"a":1}');

      component.triggerUndo();

      expect(editor.trigger).toHaveBeenCalledOnceWith('jotjson', 'undo', null);
    });

    it('keeps undo history when valueChange is echoed back through the value input', async () => {
      const component = await create('{"a":1}');
      const emittedValues: string[] = [];
      component.valueChange.subscribe((value) => emittedValues.push(value));
      editor.setValue.calls.reset();

      expect(component.applyEdit(5, 6, '2', 'extract-embedded-json')).toBeTrue();
      expect(emittedValues).toEqual(['{"a":2}']);

      const echoedValue = emittedValues[0];
      if (echoedValue === undefined) {
        fail('Expected valueChange to emit after applyEdit');
        return;
      }
      fixture.componentRef.setInput('value', echoedValue);
      fixture.detectChanges();

      expect(editor.setValue).not.toHaveBeenCalled();

      component.triggerUndo();
      expect(editor.getValue()).toBe('{"a":1}');
    });
  });

  describe('revealRange', () => {
    it('calls setSelection with end coords first (reversed Selection) and reveals it', async () => {
      const component = await create('{"a":1}');
      component.revealRange({
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 5,
      });
      expect(monaco.__selectionConstructorCalls.length).toBe(1);
      // Reversed: end coords passed FIRST, start coords SECOND. The active
      // cursor (positionLineNumber/positionColumn) lands at the start so
      // the resulting cursor change reports the start coordinate.
      expect(monaco.__selectionConstructorCalls[0]).toEqual([1, 5, 1, 2]);
      expect(editor.setSelection).toHaveBeenCalledTimes(1);
      const sel = editor.setSelection.calls.mostRecent().args[0] as FakeSelection;
      // Normalized range is still (1,2)->(1,5).
      expect(sel.startLineNumber).toBe(1);
      expect(sel.startColumn).toBe(2);
      expect(sel.endLineNumber).toBe(1);
      expect(sel.endColumn).toBe(5);
      expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledTimes(1);
    });

    it('does not call focus() (selection should not steal focus from the tree)', async () => {
      // FakeEditor has no focus spy at all - verify nothing on the editor
      // matches the focus contract.
      const component = await create('{"a":1}');
      expect((editor as unknown as { focus?: jasmine.Spy }).focus).toBeUndefined();
      component.revealRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2,
      });
      expect(editor.setSelection).toHaveBeenCalled();
    });

    it('no-ops when the editor is not yet ready', async () => {
      // Construct via TestBed but DO NOT mount Monaco (skip detectChanges).
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [JsonEditorComponent],
        providers: [...provideFakeAuth(), { provide: LoggerService, useValue: logger }],
      }).compileComponents();
      const earlyFixture = TestBed.createComponent(JsonEditorComponent);
      earlyFixture.componentRef.setInput('value', '{}');
      // Calling revealRange before ngAfterViewInit settles must not throw
      // and must not have any observable effect.
      expect(() =>
        earlyFixture.componentInstance.revealRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        }),
      ).not.toThrow();
      expect(editor.setSelection).not.toHaveBeenCalled();
    });
  });
});
