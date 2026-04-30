/**
 * Minimal Monaco stub for tests that mount `JsonEditorComponent` indirectly
 * (e.g., via `HomeComponent`). Provides just enough of the `monaco` namespace
 * surface area to let the editor's lifecycle (ngAfterViewInit + ngOnDestroy +
 * value/errors changes + revealRange) complete without crashing.
 *
 * Tests that directly assert against Monaco interactions (the
 * `JsonEditorComponent` unit spec) keep their own `FakeMonaco` with Jasmine
 * spies. This helper is deliberately spy-less: it is for tests that just
 * need the editor not to throw while exercising other component logic.
 *
 * Usage:
 *
 *   beforeEach(() => installMinimalMonacoStub());
 *   afterEach(() => restoreMonacoStub());
 */
import type * as MonacoNS from 'monaco-editor';

interface SavedMonaco {
  previous: typeof MonacoNS | undefined;
}

let saved: SavedMonaco | undefined;

function makeNoopDisposable(): { dispose: () => void } {
  return { dispose: () => undefined };
}

function makeMinimalEditor(initialValue: string): object {
  let current = initialValue;
  const model = {
    getValue: () => current,
    getValueInRange: () => '',
    getOffsetAt: () => 0
  };
  return {
    getValue: () => current,
    setValue: (next: string) => {
      current = next;
    },
    getModel: () => model,
    onDidChangeModelContent: () => makeNoopDisposable(),
    onDidChangeCursorPosition: () => makeNoopDisposable(),
    onDidPaste: () => makeNoopDisposable(),
    updateOptions: () => undefined,
    dispose: () => undefined,
    executeEdits: () => true,
    layout: () => undefined,
    setSelection: () => undefined,
    revealRangeInCenterIfOutsideViewport: () => undefined
  };
}

function NoopSelection(this: object): void {
  // Constructor only - the minimal stub never reads selection fields.
}

function buildMinimalMonaco(): typeof MonacoNS {
  const stub = {
    editor: {
      create: (_host: HTMLElement, options: { value?: string } | undefined) =>
        makeMinimalEditor(
          options && typeof options.value === 'string' ? options.value : ''
        ),
      defineTheme: () => undefined,
      setTheme: () => undefined,
      setModelMarkers: () => undefined
    },
    json: {
      jsonDefaults: {
        setDiagnosticsOptions: () => undefined
      }
    },
    MarkerSeverity: { Error: 8 },
    Selection: NoopSelection
  };
  return stub as unknown as typeof MonacoNS;
}

export function installMinimalMonacoStub(): void {
  if (saved) {
    throw new Error(
      'installMinimalMonacoStub: already installed. Call restoreMonacoStub() first.'
    );
  }
  const winRef = window as unknown as { monaco?: typeof MonacoNS };
  saved = { previous: winRef.monaco };
  winRef.monaco = buildMinimalMonaco();
}

export function restoreMonacoStub(): void {
  if (!saved) return;
  const winRef = window as unknown as { monaco?: typeof MonacoNS };
  if (saved.previous === undefined) {
    delete winRef.monaco;
  } else {
    winRef.monaco = saved.previous;
  }
  saved = undefined;
}
