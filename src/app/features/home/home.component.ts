import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { format as jsoncFormat, applyEdits, ParseError } from 'jsonc-parser';
import { DraftService } from '../../core/preferences/draft.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import {
  JsonParserService,
  JsonParseResult
} from '../../core/json/json-parser.service';
import { JsonEditorComponent } from '../../shared/components/json-editor/json-editor.component';
import { JsonTreeComponent } from '../../shared/components/json-tree/json-tree.component';
import {
  EditorMode,
  ToolbarComponent
} from '../../shared/components/toolbar/toolbar.component';

/**
 * Primary editor + tree experience. Home is an anonymous page — persistence
 * goes to localStorage via DraftService (spec §Features #1 / §Milestones #2).
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [JsonEditorComponent, JsonTreeComponent, ToolbarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss'
})
export class HomeComponent {
  private readonly draft = inject(DraftService);
  private readonly prefs = inject(PreferencesService);
  private readonly parser = inject(JsonParserService);

  readonly content = signal(this.draft.content());
  readonly mode = signal<EditorMode>(this.detectMode(this.draft.content()));

  readonly parseResult = computed<JsonParseResult>(() =>
    this.parser.parse(this.content())
  );

  readonly errors = computed(() => this.parseResult().errors);

  readonly treeValue = computed<unknown>(() => {
    const r = this.parseResult();
    return r.empty ? undefined : r.value;
  });

  readonly layoutOrientation = computed(() => this.prefs.prefs().layoutOrientation);

  readonly hasContent = computed(() => this.content().trim().length > 0);

  readonly splitRatio = signal(this.loadSplitRatio());

  readonly splitStyle = computed(() => {
    const r = this.splitRatio();
    const a = `${(r * 100).toFixed(3)}%`;
    const b = `${((1 - r) * 100).toFixed(3)}%`;
    return this.layoutOrientation() === 'vertical'
      ? { 'grid-template-rows': `${a} var(--splitter-size) ${b}` }
      : { 'grid-template-columns': `${a} var(--splitter-size) ${b}` };
  });

  private readonly splitHost =
    viewChild<ElementRef<HTMLElement>>('splitHost');

  private readonly treeHost =
    viewChild<ElementRef<HTMLElement>>('treeHost');

  constructor() {
    // Persist edits to the draft.
    effect(() => {
      this.draft.set(this.content());
    });

    // Auto-switch to JSONC when comments appear.
    effect(() => {
      if (this.detectMode(this.content()) === 'jsonc' && this.mode() === 'json') {
        this.mode.set('jsonc');
      }
    });

    // Persist split ratio to localStorage (local-only; not synced via prefs).
    effect(() => {
      const r = this.splitRatio();
      try {
        localStorage.setItem('jotjson.splitRatio.v1', String(r));
      } catch {
        /* storage unavailable */
      }
    });
  }

  onSplitterPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const host = this.splitHost()?.nativeElement;
    if (!host) return;
    ev.preventDefault();
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const vertical = this.layoutOrientation() === 'vertical';

    const move = (e: PointerEvent): void => {
      const rect = host.getBoundingClientRect();
      const raw = vertical
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(0.9, Math.max(0.1, raw));
      this.splitRatio.set(clamped);
    };

    const end = (e: PointerEvent): void => {
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  private loadSplitRatio(): number {
    try {
      const raw = localStorage.getItem('jotjson.splitRatio.v1');
      if (!raw) return 0.5;
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0.5;
      return Math.min(0.9, Math.max(0.1, n));
    } catch {
      return 0.5;
    }
  }

  onValueChange(next: string): void {
    this.content.set(next);
  }

  async onPaste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim().length > 0) {
        this.content.set(text);
      }
    } catch {
      // Clipboard unavailable / denied — graceful fallback: user can still Ctrl+V.
    }
  }

  async onUpload(file: File): Promise<void> {
    const MAX = 5 * 1024 * 1024;
    if (file.size > MAX) {
      console.warn($localize`:@@upload.tooLarge.log:File too large (max 5 MB)`);
      return;
    }
    const text = await file.text();
    this.content.set(text);
  }

  onDownload(): void {
    const text = this.content();
    const ext = this.mode() === 'jsonc' ? 'jsonc' : 'json';
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jotjson-untitled.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  onClear(): void {
    this.content.set('');
  }

  onFormat(): void {
    const text = this.content();
    if (!text) return;
    const edits = jsoncFormat(text, undefined, {
      tabSize: this.prefs.prefs().editorTabSize,
      insertSpaces: true,
      eol: '\n'
    });
    const next = applyEdits(text, edits);
    if (next !== text) this.content.set(next);
  }

  onMinify(): void {
    const parsed = this.parseResult();
    if (parsed.empty || parsed.errors.length > 0) return;
    try {
      this.content.set(JSON.stringify(parsed.value));
      // Minified output has no comments → switch back to JSON mode.
      this.mode.set('json');
    } catch {
      /* ignore */
    }
  }

  onModeChange(mode: EditorMode): void {
    this.mode.set(mode);
  }

  onToggleLayout(): void {
    const next =
      this.prefs.prefs().layoutOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    this.prefs.update({ layoutOrientation: next });
  }

  onToggleTheme(): void {
    // Three-state cycle driven by the raw preference: light -> dark -> system.
    // 'system' follows the OS's prefers-color-scheme setting.
    const current = this.prefs.prefs().theme;
    const next =
      current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    this.prefs.update({ theme: next });
  }

  focusTreeSearch(): void {
    const host = this.treeHost()?.nativeElement;
    const input = host?.querySelector<HTMLInputElement>('.tree-search');
    input?.focus();
    input?.select();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent): void {
    // Ctrl+Shift+] / Ctrl+Shift+[ — expand/collapse all
    if (ev.ctrlKey && ev.shiftKey && (ev.key === ']' || ev.key === '[')) {
      const tree = this.treeHost()?.nativeElement;
      if (!tree) return;
      ev.preventDefault();
      const btn = tree.querySelector<HTMLButtonElement>(
        ev.key === ']' ? '.tree-btn:nth-of-type(1)' : '.tree-btn:nth-of-type(2)'
      );
      btn?.click();
      return;
    }

    // Alt+1..9 — expand to level N (uses Alt to avoid browser tab shortcuts per spec)
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && /^[1-9]$/.test(ev.key)) {
      const tree = this.treeHost()?.nativeElement;
      const select = tree?.querySelector<HTMLSelectElement>('.tree-select');
      if (select) {
        ev.preventDefault();
        select.value = ev.key;
        select.dispatchEvent(new Event('change'));
      }
      return;
    }

    // Ctrl+F when focus is NOT in the editor → focus tree search. When in the
    // editor, Monaco's native find runs.
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
      const active = document.activeElement;
      const inEditor = active?.closest('.monaco-editor') != null;
      if (!inEditor) {
        ev.preventDefault();
        this.focusTreeSearch();
      }
    }
  }

  private detectMode(text: string): EditorMode {
    if (!text) return 'json';
    // Quick heuristic: look for // or /* that aren't inside strings. Use the
    // parser's error output: if parsing succeeds with comments allowed and the
    // text contains // or /*, it's JSONC.
    if (/\/\/|\/\*/.test(text)) return 'jsonc';
    return 'json';
  }
}
