import { ComponentFixture, TestBed } from '@angular/core/testing';
import { JsonEditorComponent } from './json-editor.component';
import type { JsonParseError } from '../../../core/json/json-parser.service';
import { provideFakeAuth } from '../../../../testing/auth.testing';

const STORAGE_KEY = 'jotjson.preferences.v1';

interface FakeModel {
  id: string;
  getValue: () => string;
  getValueInRange: (range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }) => string;
  getOffsetAt: jasmine.Spy<(pos: { lineNumber: number; column: number }) => number>;
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
  Selection: new (
    selectionStartLineNumber: number,
    selectionStartColumn: number,
    positionLineNumber: number,
    positionColumn: number
  ) => FakeSelection;
  __selectionConstructorCalls: Array<
    [number, number, number, number]
  >;
}

interface FakeResizeObserver {
  observe: jasmine.Spy;
  unobserve: jasmine.Spy;
  disconnect: jasmine.Spy;
}

const FAKE_MARKER_ERROR_SEVERITY = 8;

function makeFakeEditor(initial: string): FakeEditor {
  let current = initial;
  const toOffset = (line: number, column: number): number => {
    const lines = current.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      off += lines[i].length + 1;
    }
    return off + (column - 1);
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
        toOffset(position.lineNumber, position.column)
      )
  };
  return {
    getValue: jasmine.createSpy('getValue').and.callFake(() => current),
    setValue: jasmine.createSpy('setValue').and.callFake((v: string) => {
      current = v;
    }),
    getModel: jasmine.createSpy('getModel').and.returnValue(model),
    onDidChangeModelContent: jasmine.createSpy('onDidChangeModelContent').and.returnValue({
      dispose: () => undefined
    }),
    onDidChangeCursorPosition: jasmine.createSpy('onDidChangeCursorPosition').and.returnValue({
      dispose: () => undefined
    }),
    onDidPaste: jasmine.createSpy('onDidPaste').and.returnValue({
      dispose: () => undefined
    }),
    updateOptions: jasmine.createSpy('updateOptions'),
    dispose: jasmine.createSpy('dispose'),
    executeEdits: jasmine.createSpy('executeEdits').and.callFake(
      (
        _source: string,
        edits: Array<{
          range: {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          };
          text: string;
        }>
      ) => {
        for (const e of edits) {
          const start = toOffset(e.range.startLineNumber, e.range.startColumn);
          const end = toOffset(e.range.endLineNumber, e.range.endColumn);
          current = current.substring(0, start) + e.text + current.substring(end);
        }
        return true;
      }
    ),
    layout: jasmine.createSpy('layout'),
    setSelection: jasmine.createSpy('setSelection'),
    revealRangeInCenterIfOutsideViewport: jasmine.createSpy(
      'revealRangeInCenterIfOutsideViewport'
    )
  };
}

function makeFakeMonaco(editor: FakeEditor): FakeMonaco {
  const selectionCalls: Array<[number, number, number, number]> = [];
  function FakeSelectionCtor(
    this: FakeSelection,
    selectionStartLineNumber: number,
    selectionStartColumn: number,
    positionLineNumber: number,
    positionColumn: number
  ): FakeSelection {
    selectionCalls.push([
      selectionStartLineNumber,
      selectionStartColumn,
      positionLineNumber,
      positionColumn
    ]);
    // Selection's normalized start/end fields - smaller (line, col) is
    // start, larger is end - regardless of which corner the caller
    // passed first. The reversed-Selection trick (passing end coords
    // first) leaves these the same; only the active cursor differs.
    const startLineFirst =
      selectionStartLineNumber < positionLineNumber ||
      (selectionStartLineNumber === positionLineNumber &&
        selectionStartColumn <= positionColumn);
    this.startLineNumber = startLineFirst
      ? selectionStartLineNumber
      : positionLineNumber;
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
      setModelMarkers: jasmine.createSpy('setModelMarkers')
    },
    json: { jsonDefaults: { setDiagnosticsOptions: jasmine.createSpy('setDiagnosticsOptions') } },
    MarkerSeverity: { Error: FAKE_MARKER_ERROR_SEVERITY },
    Selection: FakeSelectionCtor as unknown as FakeMonaco['Selection'],
    __selectionConstructorCalls: selectionCalls
  };
}

describe('JsonEditorComponent', () => {
  let fixture: ComponentFixture<JsonEditorComponent>;
  let editor: FakeEditor;
  let monaco: FakeMonaco;
  let resizeObserver: FakeResizeObserver;
  let originalMonaco: unknown;
  let originalResizeObserver: typeof window.ResizeObserver | undefined;

  async function create(initial = '{"a":1}'): Promise<JsonEditorComponent> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [JsonEditorComponent],
      providers: [...provideFakeAuth()]
    }).compileComponents();
    fixture = TestBed.createComponent(JsonEditorComponent);
    fixture.componentRef.setInput('value', initial);
    fixture.detectChanges();
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

    originalMonaco = (window as unknown as { monaco?: unknown }).monaco;
    (window as unknown as { monaco: FakeMonaco }).monaco = monaco;

    originalResizeObserver = window.ResizeObserver;
    resizeObserver = {
      observe: jasmine.createSpy('observe'),
      unobserve: jasmine.createSpy('unobserve'),
      disconnect: jasmine.createSpy('disconnect')
    };
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = function () {
      return resizeObserver;
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
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

  it('creates the Monaco editor on mount', async () => {
    await create();
    expect(monaco.editor.create).toHaveBeenCalledTimes(1);
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
      { message: 'Unexpected token', offset: 5, length: 1, line: 2, column: 3 }
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
      { message: 'oops', offset: 0, length: 1, line: 1, column: 1 }
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
          endColumn: text.length + 1
        }
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

  describe('revealRange', () => {
    it('calls setSelection with end coords first (reversed Selection) and reveals it', async () => {
      const component = await create('{"a":1}');
      component.revealRange({
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 5
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
      expect(
        (editor as unknown as { focus?: jasmine.Spy }).focus
      ).toBeUndefined();
      component.revealRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 2
      });
      expect(editor.setSelection).toHaveBeenCalled();
    });

    it('no-ops when the editor is not yet ready', async () => {
      // Construct via TestBed but DO NOT mount Monaco (skip detectChanges).
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [JsonEditorComponent],
        providers: [...provideFakeAuth()]
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
          endColumn: 2
        })
      ).not.toThrow();
      expect(editor.setSelection).not.toHaveBeenCalled();
    });
  });
});
