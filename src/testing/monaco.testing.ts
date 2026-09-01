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
 *
 * A `window.monaco` stub alone is not airtight: it only covers the window
 * between `installMinimalMonacoStub()` and `restoreMonacoStub()`, and an
 * async component lifecycle can outlive its test and call `loadMonaco()`
 * in the gap. Unit-level files that must never touch the real AMD loader
 * should additionally call {@link pinMinimalMonacoLoaderForFile} once at
 * file scope (issue #513).
 */
import type * as MonacoNS from 'monaco-editor';
import { __setMonacoLoaderPromiseForTesting } from '../app/shared/components/json-editor/monaco-loader';

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
      // Single-edit invariant: real Monaco rejects overlapping ranges
      // via IIdentifiedSingleEditOperation. Rather than re-implement
      // that overlap detection in a test stub, we hard-fail on any
      // multi-edit batch so the single-edit constraint is executable
      // rather than a documented gap. Production callers
      // (json-editor.component.ts paste-unescape and applyEdit) pass
      // exactly one edit per call today; if a future caller batches
      // edits this throw fires and forces them to update both the
      // production code and this stub together.
      if (edits.length > 1) {
        throw new Error(
          'monaco.testing.ts executeEdits stub only supports single-edit batches; ' +
            'real Monaco rejects overlapping ranges and this stub does not implement ' +
            'overlap detection. Update both the caller and this stub if multi-edit ' +
            'batches are needed.',
        );
      }
      // Snapshot all offsets against the pre-edit text BEFORE applying
      // any edit, then apply from highest offset down so earlier
      // ranges do not shift under later splices. Matches Monaco's
      // documented semantics (ranges resolve against the pre-edit
      // model). The loop body is retained (rather than collapsed to a
      // single splice) so that adding multi-edit support later only
      // requires removing the guard above and adding overlap detection.
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

/**
 * Brands every stub this module builds so a spec that must reach the
 * real AMD loader can tell a leaked stub from a real `monaco`
 * namespace. Realms are shared across test files, so "is this
 * `window.monaco` mine?" is a question that actually needs answering.
 */
const MINIMAL_STUB_MARKER = '__jjMinimalMonacoStub';

function buildMinimalMonaco(): typeof MonacoNS {
  const stub = {
    [MINIMAL_STUB_MARKER]: true,
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

let pinnedMonaco: typeof MonacoNS | undefined;

/**
 * Pins `loadMonaco()` to a minimal stub for the whole calling test FILE
 * and never unpins it. Call once at file scope.
 *
 * Why this exists (issue #513): `installMinimalMonacoStub()` /
 * `restoreMonacoStub()` only cover the span of a single test. A
 * `JsonEditorComponent` lifecycle that outlives its test - an async
 * `ngAfterViewInit` reached by a late change-detection pass - calls
 * `loadMonaco()` in the uncovered gap, finds no stub, and injects the
 * real `/vs/loader.js` into a *unit* realm. Loading the real Monaco
 * distribution is the browser-integration layer's job (see
 * `DESIGN_SPEC.md` -> Testing strategy), and the injection is
 * irreversible per realm.
 *
 * This pins **only** the loader override and deliberately does NOT
 * touch `window.monaco`. Test realms are shared across files, and
 * `window.monaco` is the one guard `loadMonaco()` honours before
 * entering its executor - a permanent stub there would leak into the
 * browser-integration spec, hand it a stub instead of real Monaco, and
 * leave `window.MonacoEnvironment` uninitialized. The per-test
 * `installMinimalMonacoStub()` still sets `window.monaco` for the span
 * of each test, which is what keeps
 * `JsonEditorComponent.ngAfterViewInit`'s `hasCachedMonaco` check (and
 * therefore the `monaco.loaded` once-per-page-load contract) accurate
 * everywhere it is observable.
 *
 * A file that must NOT see this pin - the `JsonEditorComponent` unit
 * and browser-integration specs - clears it on entry with
 * `__setMonacoLoaderPromiseForTesting(undefined)` rather than relying
 * on the previous file to have unpinned.
 */
export function pinMinimalMonacoLoaderForFile(): void {
  if (!pinnedMonaco) {
    pinnedMonaco = buildMinimalMonaco();
  }
  __setMonacoLoaderPromiseForTesting(Promise.resolve(pinnedMonaco));
}

/**
 * Clears unit-level loader state that another spec file may have left
 * on this realm, so a spec that must exercise the REAL AMD loader is
 * never handed a stub.
 *
 * Realms are shared across test files, and `loadMonaco()` honours
 * `window.monaco` before it does anything else - so a leaked stub
 * makes it return early without initializing
 * `window.MonacoEnvironment`, which the browser-integration spec needs.
 * The predecessor of `__resetMonacoLoaderCacheForTesting()` used to
 * delete `window.monaco` unconditionally and covered this by accident;
 * this helper does it deliberately and narrowly.
 *
 * A **real** `monaco` namespace is left alone on purpose: re-requiring
 * an already-evaluated `vs/editor/editor.main` does not re-assign
 * `window.monaco`, so deleting a real one would be unrecoverable
 * within the realm.
 */
export function clearLeakedMonacoStub(): void {
  __setMonacoLoaderPromiseForTesting(undefined);
  const current: unknown = window.monaco;
  if (typeof current === 'object' && current !== null && MINIMAL_STUB_MARKER in current) {
    delete window.monaco;
  }
}
