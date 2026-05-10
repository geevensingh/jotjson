import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type * as MonacoNS from 'monaco-editor';
import { JsonParseError, JsonParserService } from '../../../core/json/json-parser.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { loadMonaco } from './monaco-loader';

@Component({
  selector: 'jj-json-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss',
})
export class JsonEditorComponent implements AfterViewInit, OnDestroy {
  private readonly prefs = inject(PreferencesService);
  private readonly parser = inject(JsonParserService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);
  private readonly logger = inject(LoggerService);

  readonly value = input<string>('');
  readonly errors = input<JsonParseError[]>([]);
  readonly valueChange = output<string>();
  readonly cursorPositionChange = output<{
    line: number;
    column: number;
    offset: number;
  }>();
  readonly paste = output<{
    pastedText: string;
    postPasteContent: string;
    postPasteParses: boolean;
  }>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  private editor: MonacoNS.editor.IStandaloneCodeEditor | undefined;
  private monaco: typeof MonacoNS | undefined;
  private suppressChange = false;
  private resizeObs: ResizeObserver | undefined;

  readonly ready = signal(false);
  readonly hasErrors = computed(() => this.errors().length > 0);

  constructor() {
    // Push external value changes into the editor.
    effect(() => {
      const next = this.value();
      const ed = this.editor;
      if (!ed) return;
      if (ed.getValue() === next) return;
      this.suppressChange = true;
      ed.setValue(next);
      this.suppressChange = false;
    });

    // React to preference changes (font-size, wrap, tab size).
    effect(() => {
      const currentPrefs = this.prefs.prefs();
      this.editor?.updateOptions({
        fontSize: currentPrefs.editorFontSize,
        tabSize: currentPrefs.editorTabSize,
        wordWrap: currentPrefs.editorWordWrap ? 'on' : 'off',
      });
    });

    // Theme.
    effect(() => {
      const theme = this.prefs.effectiveTheme();
      if (this.monaco) {
        this.monaco.editor.setTheme(theme === 'light' ? 'jotjson-light' : 'jotjson-dark');
      }
    });

    // Push parser errors into Monaco markers.
    effect(() => this.applyMarkers(this.errors()));
  }

  async ngAfterViewInit(): Promise<void> {
    if (typeof window === 'undefined') return;

    const hasCachedMonaco = window.monaco !== undefined;
    let monaco: typeof MonacoNS;
    try {
      if (hasCachedMonaco) {
        monaco = await loadMonaco();
      } else {
        const loadStartTimeMs = performance.now();
        monaco = await loadMonaco();
        const loadTimeMs = performance.now() - loadStartTimeMs;
        this.logger.event('monaco.loaded', undefined, { loadTimeMs });
      }
    } catch (error) {
      this.logger.error('monaco.loadFailed', error);
      return;
    }
    // The await above can resolve after the component's view has
    // already been destroyed (e.g., user navigates away mid-load, or a
    // test fixture is torn down between it() blocks). If we proceed,
    // we'd allocate a Monaco instance + ResizeObserver that
    // ngOnDestroy() has already run past, leaking them as zombies.
    if (this.destroyRef.destroyed) return;
    this.monaco = monaco;

    this.defineThemes(monaco);
    const theme = this.prefs.effectiveTheme();
    const currentPrefs = this.prefs.prefs();

    this.zone.runOutsideAngular(() => {
      const editor = monaco.editor.create(this.host().nativeElement, {
        value: this.value(),
        language: 'json',
        theme: theme === 'light' ? 'jotjson-light' : 'jotjson-dark',
        fontSize: currentPrefs.editorFontSize,
        tabSize: currentPrefs.editorTabSize,
        wordWrap: currentPrefs.editorWordWrap ? 'on' : 'off',
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        formatOnPaste: false,
        renderWhitespace: 'selection',
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
        fontLigatures: true,
        lineNumbersMinChars: 3,
        folding: true,
        bracketPairColorization: { enabled: true },
        // M7g-3c: explicit a11y options. `auto` lets Monaco re-detect when a
        // screen reader becomes active rather than probing once at boot, and
        // `ariaLabel` gives the editor textarea a meaningful accessible name
        // (Monaco writes this onto the inner <textarea> on focus). The
        // built-in `editor.action.accessibilityHelp` action (Ctrl+F1 / Cmd+F1)
        // remains reachable for users who need it.
        accessibilitySupport: 'auto',
        ariaLabel: $localize`:@@editor.aria:JSON editor`,
      });

      // JotJSON is JSONC - defer validation to our parser.
      monaco.json.jsonDefaults.setDiagnosticsOptions({
        validate: false,
        allowComments: true,
        trailingCommas: 'ignore',
      });

      editor.onDidChangeModelContent(() => {
        if (this.suppressChange) return;
        const editorValue = editor.getValue();
        this.zone.run(() => this.valueChange.emit(editorValue));
      });

      editor.onDidChangeCursorPosition((event) => {
        const model = editor.getModel();
        const offset = model ? model.getOffsetAt(event.position) : 0;
        const payload = {
          line: event.position.lineNumber,
          column: event.position.column,
          offset,
        };
        this.zone.run(() => this.cursorPositionChange.emit(payload));
      });

      // Auto-unescape pasted JSON (issue #38). Only rewrite when the pasted
      // region is itself an escaped JSON document AND unescaping it leaves the
      // full buffer parseable - prevents us from rewriting legitimate string
      // values that happen to contain escape sequences.
      editor.onDidPaste((event) => {
        const model = editor.getModel();
        if (!model) return;
        const pasted = model.getValueInRange(event.range);
        if (!pasted) {
          return;
        }
        let postRange: MonacoNS.IRange = event.range;
        const { unescaped, changed } = this.parser.tryUnescape(pasted);
        if (changed) {
          const full = model.getValue();
          const before = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: event.range.startLineNumber,
            endColumn: event.range.startColumn,
          });
          const after = full.substring(before.length + pasted.length);
          const hypothetical = before + unescaped + after;
          if (!this.parser.parse(hypothetical).errors.length) {
            editor.executeEdits('jotjson-unescape-paste', [
              { range: event.range, text: unescaped, forceMoveMarkers: true },
            ]);
            const lines = unescaped.split('\n');
            const endLineNumber = event.range.startLineNumber + lines.length - 1;
            const endColumn =
              lines.length === 1
                ? event.range.startColumn + unescaped.length
                : lines[lines.length - 1].length + 1;
            postRange = {
              startLineNumber: event.range.startLineNumber,
              startColumn: event.range.startColumn,
              endLineNumber,
              endColumn,
            };
          }
        }

        // Emit a single paste event per Monaco paste action, reflecting the
        // post-rewrite state. Read the model authoritatively so consumers see
        // the same text Monaco committed (whether unescape ran or not).
        const pastedText = model.getValueInRange(postRange);
        const postPasteContent = model.getValue();
        const parseResult = this.parser.parse(postPasteContent);
        const postPasteParses =
          parseResult.errors.length === 0 &&
          typeof parseResult.value === 'object' &&
          parseResult.value !== null;
        this.zone.run(() => this.paste.emit({ pastedText, postPasteContent, postPasteParses }));
      });

      this.editor = editor;

      const ro = new ResizeObserver(() => editor.layout());
      ro.observe(this.host().nativeElement);
      this.resizeObs = ro;
    });

    // Apply any errors that arrived before Monaco was ready.
    this.applyMarkers(this.errors());

    this.ready.set(true);
  }

  ngOnDestroy(): void {
    this.dispose();
  }

  /**
   * Programmatically select a range and scroll it into view (only if it's
   * outside the current viewport - avoids unnecessary jumps). Used by the
   * tree-to-editor selection sync. The Selection is constructed with the
   * end coordinates first so the active cursor lands at the start of the
   * range, which keeps the visible selection feeling natural and prevents
   * the editor from triggering a snap-back on the matching tree row when
   * the user clicks a tree node. No `focus()` - the click belongs to the
   * tree pane and we don't want to steal it.
   */
  revealRange(range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  }): void {
    const editor = this.editor;
    const monaco = this.monaco;
    if (!editor || !monaco) return;
    this.zone.runOutsideAngular(() => {
      const selection = new monaco.Selection(
        range.endLineNumber,
        range.endColumn,
        range.startLineNumber,
        range.startColumn,
      );
      editor.setSelection(selection);
      editor.revealRangeInCenterIfOutsideViewport(selection);
    });
  }

  private applyMarkers(errs: readonly JsonParseError[]): void {
    const model = this.editor?.getModel();
    const monaco = this.monaco;
    if (!model || !monaco) return;
    monaco.editor.setModelMarkers(
      model,
      'jotjson',
      errs.map((parseError) => ({
        severity: monaco.MarkerSeverity.Error,
        message: parseError.message,
        startLineNumber: parseError.line,
        startColumn: parseError.column,
        endLineNumber: parseError.line,
        endColumn: parseError.column + Math.max(1, parseError.length),
      })),
    );
  }

  private dispose(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
    this.editor?.dispose();
    this.editor = undefined;
  }

  private defineThemes(monaco: typeof MonacoNS): void {
    /*
     * Per-theme JSON syntax token rules (M7f-3a). Token names verified
     * from Monaco's JSON tokenizer source (monaco-editor 0.55.1):
     *   string.value.json - JSON string values
     *   string.key.json   - JSON property names
     *   number.json       - JSON numbers (NOT plain "number")
     *   keyword.json      - true / false / null
     *
     * Colors mirror the tree palette
     * (`json-tree.component.scss:11-21`) so the editor and the tree
     * feel like one surface in both themes. AA contrast against the
     * editor background is verified by the contrast helper used in
     * existing tree specs.
     */
    monaco.editor.defineTheme('jotjson-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'string.value.json', foreground: '7fa164' },
        { token: 'number.json', foreground: 'ff9b30' },
        { token: 'keyword.json', foreground: '3fa1f3' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#e4e4e4',
      },
    });
    monaco.editor.defineTheme('jotjson-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'string.value.json', foreground: '3f6a25' },
        { token: 'number.json', foreground: '8a4b00' },
        { token: 'keyword.json', foreground: '005ea8' },
      ],
      colors: {
        'editor.background': '#fafafa',
        'editor.foreground': '#1a1a1a',
      },
    });
  }
}
