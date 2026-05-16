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
  const contentChangeHandlers: Array<() => void> = [];
  const emitContentChange = (): void => {
    for (const handler of contentChangeHandlers) {
      handler();
    }
  };
  const offsetToPosition = (offset: number): { lineNumber: number; column: number } => {
    const bounded = Math.max(0, Math.min(offset, current.length));
    const prefix = current.substring(0, bounded);
    const lines = prefix.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    return { lineNumber: lines.length, column: lastLine.length + 1 };
  };
  const positionToOffset = (lineNumber: number, column: number): number => {
    const lines = current.split('\n');
    let offset = 0;
    for (let lineIndex = 0; lineIndex < lineNumber - 1; lineIndex += 1) {
      offset += (lines[lineIndex] ?? '').length + 1;
    }
    return offset + (column - 1);
  };
  const model = {
    getValue: () => current,
    getValueInRange: (range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    }) => {
      const startOffset = positionToOffset(range.startLineNumber, range.startColumn);
      const endOffset = positionToOffset(range.endLineNumber, range.endColumn);
      return current.substring(startOffset, endOffset);
    },
    getOffsetAt: (position: { lineNumber: number; column: number }) =>
      positionToOffset(position.lineNumber, position.column),
    getPositionAt: (offset: number) => offsetToPosition(offset),
  };
  return {
    getValue: () => current,
    setValue: (next: string) => {
      current = next;
      emitContentChange();
    },
    getModel: () => model,
    onDidChangeModelContent: (handler: () => void) => {
      contentChangeHandlers.push(handler);
      return makeNoopDisposable();
    },
    onDidChangeCursorPosition: () => makeNoopDisposable(),
    onDidPaste: () => makeNoopDisposable(),
    updateOptions: () => undefined,
    dispose: () => undefined,
    executeEdits: (
      _source: string,
      edits: Array<{
        range: {
          startLineNumber: number;
          startColumn: number;
          endLineNumber: number;
          endColumn: number;
        };
        text: string;
      }>,
    ) => {
      // Snapshot all offsets against the pre-edit text BEFORE applying
      // any edit, then apply from highest offset down so earlier
      // ranges do not shift under later splices. Matches Monaco's
      // documented semantics (ranges resolve against the pre-edit
      // model). NOTE: this stub does not detect overlapping edits;
      // real Monaco rejects them via IIdentifiedSingleEditOperation,
      // but we silently apply both. Production callers only pass a
      // single edit today, so the divergence is latent.
      const offsetEdits = edits.map((edit) => ({
        start: positionToOffset(edit.range.startLineNumber, edit.range.startColumn),
        end: positionToOffset(edit.range.endLineNumber, edit.range.endColumn),
        text: edit.text,
      }));
      offsetEdits.sort((a, b) => b.start - a.start);
      for (const edit of offsetEdits) {
        current = current.substring(0, edit.start) + edit.text + current.substring(edit.end);
      }
      emitContentChange();
      return true;
    },
    trigger: () => undefined,
    layout: () => undefined,
    setSelection: () => undefined,
    revealRangeInCenterIfOutsideViewport: () => undefined,
  };
}

function NoopSelection(this: object): void {
  // Constructor only - the minimal stub never reads selection fields.
}

function NoopRange(
  this: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number,
): void {
  this.startLineNumber = startLineNumber;
  this.startColumn = startColumn;
  this.endLineNumber = endLineNumber;
  this.endColumn = endColumn;
}

function buildMinimalMonaco(): typeof MonacoNS {
  const stub = {
    editor: {
      create: (_host: HTMLElement, options: { value?: string } | undefined) =>
        makeMinimalEditor(options && typeof options.value === 'string' ? options.value : ''),
      defineTheme: () => undefined,
      setTheme: () => undefined,
      setModelMarkers: () => undefined,
    },
    json: {
      jsonDefaults: {
        setDiagnosticsOptions: () => undefined,
      },
    },
    MarkerSeverity: { Error: 8 },
    Range: NoopRange,
    Selection: NoopSelection,
  };
  return stub as unknown as typeof MonacoNS;
}

export function installMinimalMonacoStub(): void {
  if (saved) {
    throw new Error('installMinimalMonacoStub: already installed. Call restoreMonacoStub() first.');
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
