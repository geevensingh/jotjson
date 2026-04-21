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
  viewChild
} from '@angular/core';
import type * as MonacoNS from 'monaco-editor';
import { JsonParseError, JsonParserService } from '../../../core/json/json-parser.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { loadMonaco } from './monaco-loader';

@Component({
  selector: 'jj-json-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss'
})
export class JsonEditorComponent implements AfterViewInit, OnDestroy {
  private readonly prefs = inject(PreferencesService);
  private readonly parser = inject(JsonParserService);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  readonly value = input<string>('');
  readonly errors = input<JsonParseError[]>([]);
  readonly valueChange = output<string>();

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
      const p = this.prefs.prefs();
      this.editor?.updateOptions({
        fontSize: p.editorFontSize,
        tabSize: p.editorTabSize,
        wordWrap: p.editorWordWrap ? 'on' : 'off'
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

    let monaco: typeof MonacoNS;
    try {
      monaco = await loadMonaco();
    } catch (err) {
      console.error('JotJSON: Monaco failed to load', err);
      return;
    }
    this.monaco = monaco;

    this.defineThemes(monaco);
    const theme = this.prefs.effectiveTheme();
    const p = this.prefs.prefs();

    this.zone.runOutsideAngular(() => {
      const editor = monaco.editor.create(this.host().nativeElement, {
        value: this.value(),
        language: 'json',
        theme: theme === 'light' ? 'jotjson-light' : 'jotjson-dark',
        fontSize: p.editorFontSize,
        tabSize: p.editorTabSize,
        wordWrap: p.editorWordWrap ? 'on' : 'off',
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        formatOnPaste: false,
        renderWhitespace: 'selection',
        fontFamily:
          "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
        fontLigatures: true,
        lineNumbersMinChars: 3,
        folding: true,
        bracketPairColorization: { enabled: true }
      });

      // JotJSON is JSONC - defer validation to our parser.
      monaco.json.jsonDefaults.setDiagnosticsOptions({
        validate: false,
        allowComments: true,
        trailingCommas: 'ignore'
      });

      editor.onDidChangeModelContent(() => {
        if (this.suppressChange) return;
        const v = editor.getValue();
        this.zone.run(() => this.valueChange.emit(v));
      });

      // Auto-unescape pasted JSON (issue #38). Only rewrite when the pasted
      // region is itself an escaped JSON document AND unescaping it leaves the
      // full buffer parseable - prevents us from rewriting legitimate string
      // values that happen to contain escape sequences.
      editor.onDidPaste((e) => {
        const model = editor.getModel();
        if (!model) return;
        const pasted = model.getValueInRange(e.range);
        if (!pasted) return;
        const { unescaped, changed } = this.parser.tryUnescape(pasted);
        if (!changed) return;
        const full = model.getValue();
        const before = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: e.range.startLineNumber,
          endColumn: e.range.startColumn
        });
        const after = full.substring(before.length + pasted.length);
        const hypothetical = before + unescaped + after;
        if (!this.parser.parse(hypothetical).errors.length) {
          editor.executeEdits('jotjson-unescape-paste', [
            { range: e.range, text: unescaped, forceMoveMarkers: true }
          ]);
        }
      });

      this.editor = editor;

      const ro = new ResizeObserver(() => editor.layout());
      ro.observe(this.host().nativeElement);
      this.resizeObs = ro;
    });

    // Apply any errors that arrived before Monaco was ready.
    this.applyMarkers(this.errors());

    this.ready.set(true);
    this.destroyRef.onDestroy(() => this.dispose());
  }

  ngOnDestroy(): void {
    this.dispose();
  }

  private applyMarkers(errs: readonly JsonParseError[]): void {
    const model = this.editor?.getModel();
    const monaco = this.monaco;
    if (!model || !monaco) return;
    monaco.editor.setModelMarkers(
      model,
      'jotjson',
      errs.map((e) => ({
        severity: monaco.MarkerSeverity.Error,
        message: e.message,
        startLineNumber: e.line,
        startColumn: e.column,
        endLineNumber: e.line,
        endColumn: e.column + Math.max(1, e.length)
      }))
    );
  }

  private dispose(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
    this.editor?.dispose();
    this.editor = undefined;
  }

  private defineThemes(monaco: typeof MonacoNS): void {
    monaco.editor.defineTheme('jotjson-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#e4e4e4'
      }
    });
    monaco.editor.defineTheme('jotjson-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#fafafa',
        'editor.foreground': '#1a1a1a'
      }
    });
  }
}
