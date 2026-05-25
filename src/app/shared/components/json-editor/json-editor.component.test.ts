import { ComponentFixture, TestBed } from '@angular/core/testing';
import type * as MonacoNS from 'monaco-editor';
import { type Mocked, type MockInstance } from 'vitest';
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

interface FakeEditOperation {
  range: FakeRange;
  text: string;
  forceMoveMarkers?: boolean;
}

interface FakeModel {
  id: string;
  getValue: () => string;
  getValueInRange: (range: FakeRange) => string;
  getFullModelRange: () => FakeRange;
  getAlternativeVersionId: MockInstance<() => number>;
  pushEditOperations: MockInstance<
    (
      beforeCursorState: readonly FakeSelection[],
      editOperations: readonly FakeEditOperation[],
      cursorStateComputer: (
        _inverseEditOperations: readonly FakeEditOperation[],
      ) => FakeSelection[] | null,
    ) => FakeSelection[] | null
  >;
  getOffsetAt: MockInstance<(pos: { lineNumber: number; column: number }) => number>;
  getPositionAt: MockInstance<(offset: number) => { lineNumber: number; column: number }>;
}

interface FakeEditor {
  getValue: MockInstance<() => string>;
  setValue: MockInstance<(v: string) => void>;
  getModel: MockInstance<() => FakeModel | null>;
  onDidChangeModelContent: MockInstance;
  onDidChangeCursorPosition: MockInstance;
  onDidPaste: MockInstance;
  updateOptions: MockInstance;
  dispose: MockInstance;
  executeEdits: MockInstance;
  trigger: MockInstance;
  layout: MockInstance;
  setSelection: MockInstance;
  revealRangeInCenterIfOutsideViewport: MockInstance;
}

interface FakeSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface FakeMonaco {
  editor: {
    create: MockInstance<(...args: unknown[]) => FakeEditor>;
    defineTheme: MockInstance;
    setTheme: MockInstance;
    setModelMarkers: MockInstance;
  };
  json: { jsonDefaults: { setDiagnosticsOptions: MockInstance } };
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
  observe: MockInstance;
  unobserve: MockInstance;
  disconnect: MockInstance;
}

interface MonacoRequireStub {
  config: MockInstance<(configuration: { paths: Record<string, string> }) => void>;
  (modules: string[], onReady: () => void): void;
}

const FAKE_MARKER_ERROR_SEVERITY = 8;

function makeFakeEditor(initial: string): FakeEditor {
  let current = initial;
  let alternativeVersionId = 1;
  const undoStack: Array<{ value: string; alternativeVersionId: number }> = [];
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
  const applyEditOperations = (editOperations: readonly FakeEditOperation[]): void => {
    undoStack.push({ value: current, alternativeVersionId });
    for (const editOperation of editOperations) {
      const start = toOffset(editOperation.range.startLineNumber, editOperation.range.startColumn);
      const end = toOffset(editOperation.range.endLineNumber, editOperation.range.endColumn);
      current = current.substring(0, start) + editOperation.text + current.substring(end);
    }
    alternativeVersionId += 1;
    emitModelContentChange();
  };
  const model: FakeModel = {
    id: 'fake-model',
    getValue: () => current,
    getValueInRange: (range) => {
      const start = toOffset(range.startLineNumber, range.startColumn);
      const end = toOffset(range.endLineNumber, range.endColumn);
      return current.substring(start, end);
    },
    getFullModelRange: () => {
      const endPosition = toPosition(current.length);
      return {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: endPosition.lineNumber,
        endColumn: endPosition.column,
      };
    },
    getAlternativeVersionId: jasmine
      .createSpy('getAlternativeVersionId')
      .mockImplementation(() => alternativeVersionId),
    pushEditOperations: jasmine
      .createSpy('pushEditOperations')
      .mockImplementation(
        (
          _beforeCursorState: readonly FakeSelection[],
          editOperations: readonly FakeEditOperation[],
          _cursorStateComputer: (
            _inverseEditOperations: readonly FakeEditOperation[],
          ) => FakeSelection[] | null,
        ) => {
          applyEditOperations(editOperations);
          return null;
        },
      ),
    getOffsetAt: jasmine
      .createSpy('getOffsetAt')
      .mockImplementation((position: { lineNumber: number; column: number }) =>
        toOffset(position.lineNumber, position.column),
      ),
    getPositionAt: jasmine
      .createSpy('getPositionAt')
      .mockImplementation((offset: number) => toPosition(offset)),
  };
  return {
    getValue: vi.fn().mockImplementation(() => current),
    setValue: vi.fn().mockImplementation((v: string) => {
      current = v;
      undoStack.length = 0;
      alternativeVersionId += 1;
      emitModelContentChange();
    }),
    getModel: vi.fn().mockReturnValue(model),
    onDidChangeModelContent: jasmine
      .createSpy('onDidChangeModelContent')
      .mockImplementation((handler: () => void) => {
        modelContentHandlers.push(handler);
        return { dispose: () => undefined };
      }),
    onDidChangeCursorPosition: vi.fn().mockReturnValue({
      dispose: () => undefined,
    }),
    onDidPaste: vi.fn().mockReturnValue({
      dispose: () => undefined,
    }),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
    executeEdits: jasmine
      .createSpy('executeEdits')
      .mockImplementation((_source: string, edits: readonly FakeEditOperation[]) => {
        applyEditOperations(edits);
        return true;
      }),
    trigger: jasmine
      .createSpy('trigger')
      .mockImplementation((_source: string, handlerId: string, _payload: unknown) => {
        if (handlerId !== 'undo') {
          return;
        }
        const previousState = undoStack.pop();
        if (previousState === undefined) {
          return;
        }
        current = previousState.value;
        alternativeVersionId = previousState.alternativeVersionId;
        emitModelContentChange();
      }),
    layout: vi.fn(),
    setSelection: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
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
      create: vi.fn().mockReturnValue(editor),
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      setModelMarkers: vi.fn(),
    },
    json: { jsonDefaults: { setDiagnosticsOptions: vi.fn() } },
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
  let logger: Mocked<LoggerService>;
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
    logger = { error: vi.fn(), event: vi.fn() } as Mocked<LoggerService>;
    minimalMonacoInstalled = false;

    originalMonaco = (window as unknown as { monaco?: unknown }).monaco;
    (window as unknown as { monaco: FakeMonaco }).monaco = monaco;

    originalResizeObserver = window.ResizeObserver;
    resizeObserver = {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
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
    expect(emitted).toBe(false);
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
    expect(logger.event).toHaveBeenCalledWith('monaco.loaded', undefined, {
      loadTimeMs: expect.any(Number),
    });
    // PreferencesService also emits `theme.applied` (source: 'boot')
    // during construction, so the spy receives more than one call.
    // Verify `monaco.loaded` itself was emitted exactly once.
    const monacoLoadedCalls = logger.event.calls
      .allArgs()
      .filter((args) => args[0] === 'monaco.loaded');
    expect(monacoLoadedCalls.length).toBe(1);
    const measurements = monacoLoadedCalls[0]?.[2];
    if (!measurements) {
      expect.fail('monaco.loaded measurements were not captured');
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
    const [messageId, cause] = logger.error.mock.lastCall;
    expect(messageId).toBe('monaco.loadFailed');
    expect(cause).toEqual(expect.any(Error));
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
    expect(component.ready()).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('pushes external value changes into the editor via setValue', async () => {
    await create('{"a":1}');
    editor.setValue.mockClear();
    fixture.componentRef.setInput('value', '{"b":2}');
    fixture.detectChanges();
    expect(editor.setValue).toHaveBeenCalledTimes(1);
    expect(editor.setValue).toHaveBeenCalledWith('{"b":2}');
  });

  it('does not call setValue when the input matches the current editor value (no echo)', async () => {
    await create('{"a":1}');
    editor.setValue.mockClear();
    // Re-set the input to the same value the (mock) editor reports.
    fixture.componentRef.setInput('value', '{"a":1}');
    fixture.detectChanges();
    expect(editor.setValue).not.toHaveBeenCalled();
  });

  it('publishes Monaco markers when the errors input changes', async () => {
    await create('{"a":1}');
    monaco.editor.setModelMarkers.mockClear();

    const errs: JsonParseError[] = [
      { message: 'Unexpected token', offset: 5, length: 1, line: 2, column: 3 },
    ];
    fixture.componentRef.setInput('errors', errs);
    fixture.detectChanges();

    expect(monaco.editor.setModelMarkers).toHaveBeenCalledTimes(1);
    const args = monaco.editor.setModelMarkers.mock.lastCall;
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
    monaco.editor.setModelMarkers.mockClear();
    fixture.componentRef.setInput('errors', []);
    fixture.detectChanges();
    expect(monaco.editor.setModelMarkers).toHaveBeenCalledTimes(1);
    expect(monaco.editor.setModelMarkers.mock.lastCall[2]).toEqual([]);
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
      const handler = editor.onDidPaste.mock.lastCall[0] as (event: {
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
      expect(events[0].postPasteParses).toBe(false);
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
      expect(events[0].postPasteParses).toBe(true);
    });

    it('emits paste once with valid JSON and postPasteParses=true (no unescape)', async () => {
      const component = await create('');
      const events = firePasteIntoEmpty(component, '{"a":1}');
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(events.length).toBe(1);
      expect(events[0].pastedText).toBe('{"a":1}');
      expect(events[0].postPasteContent).toBe('{"a":1}');
      expect(events[0].postPasteParses).toBe(true);
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
      const handler = editor.onDidChangeCursorPosition.mock.lastCall[0] as (event: {
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
      editor.getModel.mockReturnValue(null);
      const events = fireCursor(2, 3);
      expect(events.length).toBe(1);
      expect(events[0]).toEqual({ line: 2, column: 3, offset: 0 });
    });
  });

  describe('replaceAll, applyEdit, and undo helpers', () => {
    it('replaceAll returns modelNull and does not mutate when editor is not yet initialized', async () => {
      delete (window as unknown as { monaco?: unknown }).monaco;
      __resetMonacoLoaderForTesting();
      let resolveLoader!: (value: typeof MonacoNS) => void;
      const deferred = new Promise<typeof MonacoNS>((resolve) => {
        resolveLoader = resolve;
      });
      __setMonacoLoaderPromiseForTesting(deferred);

      const earlyFixture = await createFixtureWithoutSettling('{"a":1}');

      expect(earlyFixture.componentInstance.replaceAll('{"a":2}', 'spec-replace-all')).toBe(
        'modelNull',
      );
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(editor.getValue()).toBe('{"a":1}');

      earlyFixture.destroy();
      resolveLoader(monaco as unknown as typeof MonacoNS);
      await deferred;
      await Promise.resolve();
    });

    it('replaceAll returns noOp and does not mutate when text equals current model value', async () => {
      const component = await create('{"a":1}');
      const model = editor.getModel() as FakeModel;
      const beforeAlternativeVersionId = model.getAlternativeVersionId();
      editor.revealRangeInCenterIfOutsideViewport.mockClear();

      expect(component.replaceAll('{"a":1}', 'spec-replace-all')).toBe('noOp');
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(editor.getValue()).toBe('{"a":1}');
      expect(model.getAlternativeVersionId()).toBe(beforeAlternativeVersionId);
      expect(editor.revealRangeInCenterIfOutsideViewport).not.toHaveBeenCalled();
    });

    it('replaceAll replaces full model content and returns applied on different text', async () => {
      const component = await create('{"a":1}');
      const model = editor.getModel() as FakeModel;
      const fullRange = model.getFullModelRange();
      editor.revealRangeInCenterIfOutsideViewport.mockClear();

      expect(component.replaceAll('{"a":2}', 'spec-replace-all')).toBe('applied');
      expect(editor.getValue()).toBe('{"a":2}');
      expect(editor.executeEdits).toHaveBeenCalledTimes(1);
      const [editsSource, editOperations] = editor.executeEdits.mock.lastCall;
      expect(editsSource).toBe('spec-replace-all');
      expect(editOperations.length).toBe(1);
      const edit = editOperations[0];
      expect(edit.text).toBe('{"a":2}');
      expect(edit.range.startLineNumber).toBe(fullRange.startLineNumber);
      expect(edit.range.startColumn).toBe(fullRange.startColumn);
      expect(edit.range.endLineNumber).toBe(fullRange.endLineNumber);
      expect(edit.range.endColumn).toBe(fullRange.endColumn);
      expect(editor.revealRangeInCenterIfOutsideViewport).not.toHaveBeenCalled();
    });

    it('replaceAll returns editsRejected when executeEdits returns false despite a valid range', async () => {
      const component = await create('{"a":1}');
      editor.executeEdits.mockReturnValue(false);

      expect(component.replaceAll('{"a":2}', 'spec-replace-all')).toBe('editsRejected');
      // executeEdits was still attempted (range computed, edits passed),
      // but Monaco reported the edit was rejected; the model is left
      // unchanged so the caller's fallback can take over.
      expect(editor.executeEdits).toHaveBeenCalledTimes(1);
      expect(editor.getValue()).toBe('{"a":1}');
    });

    it('replaceAll preserves alternativeVersionId behavior (advances on edit)', async () => {
      const component = await create('{"a":1}');
      const model = editor.getModel() as FakeModel;
      const beforeAlternativeVersionId = model.getAlternativeVersionId();

      expect(component.replaceAll('{"a":2}', 'spec-replace-all')).toBe('applied');
      expect(model.getAlternativeVersionId()).toBeGreaterThan(beforeAlternativeVersionId);
    });

    it('splices text via executeEdits and preserves undo history', async () => {
      const component = await create('{"a":1}');

      expect(component.applyEdit(5, 6, '2', 'spec-apply-edit')).toBe(true);
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

      expect(earlyFixture.componentInstance.applyEdit(5, 6, '2', 'spec-apply-edit')).toBe(false);
      expect(editor.executeEdits).not.toHaveBeenCalled();

      earlyFixture.destroy();
      resolveLoader(monaco as unknown as typeof MonacoNS);
      await deferred;
      await Promise.resolve();
    });

    it('returns false when the range length assertion fails', async () => {
      const component = await create('{"a":1}');

      expect(component.applyEdit(5, 99, '2', 'spec-apply-edit')).toBe(false);
      expect(editor.executeEdits).not.toHaveBeenCalled();
      expect(editor.getValue()).toBe('{"a":1}');
    });

    it('returns false and skips reveal when executeEdits reports failure', async () => {
      const component = await create('{"a":1}');
      editor.executeEdits.mockReturnValue(false);
      editor.revealRangeInCenterIfOutsideViewport.mockClear();

      expect(component.applyEdit(5, 6, '2', 'spec-apply-edit')).toBe(false);
      expect(editor.executeEdits).toHaveBeenCalledTimes(1);
      expect(editor.revealRangeInCenterIfOutsideViewport).not.toHaveBeenCalled();
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
      editor.setValue.mockClear();

      expect(component.applyEdit(5, 6, '2', 'extract-embedded-json')).toBe(true);
      expect(emittedValues).toEqual(['{"a":2}']);

      const echoedValue = emittedValues[0];
      if (echoedValue === undefined) {
        expect.fail('Expected valueChange to emit after applyEdit');
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
      const sel = editor.setSelection.mock.lastCall[0] as FakeSelection;
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
      expect((editor as unknown as { focus?: MockInstance }).focus).toBeUndefined();
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
