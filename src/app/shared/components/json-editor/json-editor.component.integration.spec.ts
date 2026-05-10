/**
 * Browser-integration spec for `JsonEditorComponent`.
 *
 * Loads the real Monaco distribution once per suite (via the project's own
 * `loadMonaco()` AMD-loader bootstrap) and exercises the component against
 * it. This verifies:
 *   - the AMD loader is reachable at the expected `/vs/loader.js` URL
 *     under the Karma test bundle (the asset-pipeline contract),
 *   - `loadMonaco()` resolves to a real `monaco` namespace, and
 *   - `JsonEditorComponent` mounts a real editor whose value mirrors the
 *     `value` input on creation, and whose model is updated when the
 *     `value` input changes.
 *
 * Out of scope at this layer (deliberately): JSON-worker correctness,
 * paste auto-unescape behavior, marker lifecycle assertions. Those are
 * already covered by the unit spec with `FakeMonaco` and re-verifying
 * them here would add brittleness without bounded value. See
 * DESIGN_SPEC.md > Testing strategy.
 *
 * Implementation notes:
 *   - This spec deliberately does NOT use `fixture.whenStable()`. Real
 *     Monaco's ResizeObserver + worker bootstrap leave indefinite pending
 *     tasks in Angular's zone, and `whenStable()` will not resolve.
 *     Instead, we poll the component's `ready` signal (which is set to
 *     `true` at the end of `ngAfterViewInit`) with a short timeout cap.
 *   - We access the component's private `editor` field via a cast. Test
 *     files are explicitly allowed to do this per AGENTS.md.
 *   - Monaco's editor worker is intentionally STUBBED in `beforeAll`
 *     (see `installNoopMonacoWorker()` below). The integration spec only
 *     exercises loader-resolution, editor mount, value mirroring, and
 *     a11y-options threading - none of which require a real worker. The
 *     real worker fetch (`/vs/assets/editor.worker-*.js`) was the source
 *     of an intermittent CI-only NetworkError that disconnected the
 *     Karma browser slot mid-suite. Stubbing `MonacoEnvironment.getWorker`
 *     with a no-op Worker eliminates the fetch entirely.
 */
import { TestBed } from '@angular/core/testing';
import type * as MonacoNS from 'monaco-editor';
import { JsonEditorComponent } from './json-editor.component';
import { __resetMonacoLoaderForTesting, loadMonaco } from './monaco-loader';
import { provideFakeAuth } from '../../../../testing/auth.testing';

const STORAGE_KEY = 'jotjson.preferences.v1';
const HOST_WIDTH_PX = 800;
const HOST_HEIGHT_PX = 600;
const READY_POLL_MS = 25;
const READY_TIMEOUT_MS = 3000;

interface ComponentTestProbe {
  ready: () => boolean;
  editor?: MonacoNS.editor.IStandaloneCodeEditor;
}

function probe(component: JsonEditorComponent): ComponentTestProbe {
  return component as unknown as ComponentTestProbe;
}

async function waitUntilReady(component: JsonEditorComponent): Promise<void> {
  const start = Date.now();
  while (!probe(component).ready()) {
    if (Date.now() - start > READY_TIMEOUT_MS) {
      throw new Error(`JsonEditorComponent did not become ready within ${READY_TIMEOUT_MS}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

async function mountSizedFixture(initialValue: string): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<JsonEditorComponent>>;
  hostEl: HTMLElement;
  component: JsonEditorComponent;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [JsonEditorComponent],
    providers: [...provideFakeAuth()],
  }).compileComponents();

  const fixture = TestBed.createComponent(JsonEditorComponent);
  const hostEl = fixture.nativeElement as HTMLElement;
  hostEl.style.width = `${HOST_WIDTH_PX}px`;
  hostEl.style.height = `${HOST_HEIGHT_PX}px`;
  hostEl.style.display = 'block';
  document.body.appendChild(hostEl);

  fixture.componentRef.setInput('value', initialValue);
  fixture.detectChanges();
  await waitUntilReady(fixture.componentInstance);
  fixture.detectChanges();

  return { fixture, hostEl, component: fixture.componentInstance };
}

describe('JsonEditorComponent (browser integration)', () => {
  let monaco: typeof MonacoNS;
  let noopWorkerBlobUrl: string | undefined;

  beforeAll(async () => {
    __resetMonacoLoaderForTesting();
    monaco = await loadMonaco();
    installNoopMonacoWorker();
  });

  afterAll(() => {
    if (noopWorkerBlobUrl) {
      URL.revokeObjectURL(noopWorkerBlobUrl);
      noopWorkerBlobUrl = undefined;
    }
    __resetMonacoLoaderForTesting();
  });

  /**
   * Replace Monaco's worker bootstrap with a no-op Worker so the suite
   * never fetches `/vs/assets/editor.worker-*.js`. The fetch was the
   * source of an intermittent CI-only NetworkError that disconnected
   * the Karma browser slot mid-suite (~63% per-attempt failure rate).
   *
   * Monaco's documented Environment interface declares both
   * `getWorker?(workerId, label): Worker | Promise<Worker>` and
   * `getWorkerUrl?(workerId, label): string`, with `getWorker` taking
   * precedence when set. `loadMonaco()` sets `getWorkerUrl`; this
   * helper augments the same `MonacoEnvironment` object with a
   * `getWorker` that returns a Worker driven by an inline blob URL
   * containing only `self.onmessage = () => {};`. Monaco posts to it
   * and never gets a response - which is fine because the integration
   * spec only exercises loader resolution, editor mount, value
   * mirroring, and a11y-options threading. None of those require
   * worker round-trips, and JsonEditorComponent disables Monaco JSON
   * diagnostics (json-editor.component.ts) so no language-service
   * worker call is ever made.
   *
   * The blob URL is created once per suite and revoked in `afterAll`.
   * Per Monaco's runtime, calling `getWorker` is sufficient to suppress
   * the fallback `getWorkerUrl` path.
   */
  function installNoopMonacoWorker(): void {
    if (!window.MonacoEnvironment) {
      throw new Error('loadMonaco() did not initialize window.MonacoEnvironment');
    }
    const blobUrl = URL.createObjectURL(
      new Blob(['self.onmessage = () => {};'], { type: 'text/javascript' }),
    );
    noopWorkerBlobUrl = blobUrl;
    window.MonacoEnvironment.getWorker = () => new Worker(blobUrl);
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('loadMonaco resolves with a real monaco namespace', () => {
    expect(monaco).toBeDefined();
    expect(typeof monaco.editor.create).toBe('function');
    expect(typeof monaco.editor.defineTheme).toBe('function');
    expect(monaco.MarkerSeverity.Error).toBeGreaterThan(0);
  });

  it('mounts a real editor whose getValue matches the value input', async () => {
    const initial = '{"a":1}';
    const { fixture, hostEl, component } = await mountSizedFixture(initial);
    try {
      const editor = probe(component).editor;
      expect(editor).toBeDefined();
      expect(editor!.getValue()).toBe(initial);
    } finally {
      fixture.destroy();
      hostEl.remove();
    }
  });

  it('propagates value-input updates into the editor model', async () => {
    const { fixture, hostEl, component } = await mountSizedFixture('{"a":1}');
    try {
      const editor = probe(component).editor;
      expect(editor).toBeDefined();
      expect(editor!.getValue()).toBe('{"a":1}');

      fixture.componentRef.setInput('value', '{"b":2}');
      fixture.detectChanges();
      // Effect runs synchronously during detectChanges and calls
      // editor.setValue, so the next read sees the new value.
      expect(editor!.getValue()).toBe('{"b":2}');
    } finally {
      fixture.destroy();
      hostEl.remove();
    }
  });

  // --------------------------------------------------------------------
  // M7g-3c: explicit a11y options on monaco.editor.create()
  // --------------------------------------------------------------------
  // These specs verify the explicit a11y options we set on
  // `monaco.editor.create(...)` in JsonEditorComponent:
  //   - `accessibilitySupport: 'auto'`  - Monaco re-detects when an SR
  //     becomes active rather than probing once at boot,
  //   - `ariaLabel: 'JSON editor'`      - gives the editor a meaningful
  //     accessible name (Monaco threads this through
  //     `ariaLabelForScreenReaderContent` onto the screen-reader content
  //     element: in modern Chrome that is a <div class="native-edit-context"
  //     role="textbox">; in older browsers it is a <textarea
  //     class="inputarea">).
  //
  // Out of scope at this layer (deliberately): a strict axe scan of the
  // Monaco-rendered DOM. Monaco's internal markup is upstream-tracked and
  // we do not own its WCAG conformance. See DESIGN_SPEC.md > Accessibility
  // for the M7g audit decisions.
  //
  // Also out of scope: asserting a registered
  // `editor.action.accessibilityHelp` action. The accessibility-help
  // dialog (Ctrl+F1 / Cmd+F1) is contributed via vscode-workbench code
  // that is NOT shipped in standalone monaco-editor; within standalone
  // monaco the id is referenced only by the diff editor's keybinding
  // lookup. We therefore cannot verify a registered action with that id
  // from this layer.
  describe('a11y options (M7g-3c)', () => {
    it('passes ariaLabel="JSON editor" to monaco.editor.create()', async () => {
      const { fixture, hostEl, component } = await mountSizedFixture('{"a":1}');
      try {
        const editor = probe(component).editor;
        expect(editor).toBeDefined();
        // Construction-time assertion: what we passed to editor.create().
        const rawOptions = editor!.getRawOptions();
        expect(rawOptions.ariaLabel).toBe('JSON editor');
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });

    it('passes accessibilitySupport="auto" and the resolved option is a valid enum value', async () => {
      const { fixture, hostEl, component } = await mountSizedFixture('{"a":1}');
      try {
        const editor = probe(component).editor;
        expect(editor).toBeDefined();
        // Construction-time: assert the literal we passed in.
        expect(editor!.getRawOptions().accessibilitySupport).toBe('auto');
        // Resolved-runtime: 'auto' becomes one of the AccessibilitySupport
        // enum values (Unknown=0, Disabled=1, Enabled=2). The exact value
        // depends on Monaco's environment probe; we only assert it is one
        // of those.
        const resolved = editor!.getOption(monaco.editor.EditorOption.accessibilitySupport);
        expect([0, 1, 2]).toContain(resolved);
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });

    it("threads our ariaLabel through to Monaco's screen-reader content element", async () => {
      const { fixture, hostEl, component } = await mountSizedFixture('{"a":1}');
      try {
        const editor = probe(component).editor;
        expect(editor).toBeDefined();

        // Monaco has TWO screen-reader content paths and which one runs
        // depends on whether the browser supports the EditContext API:
        //
        //   1. Legacy path (no EditContext): a <textarea class="inputarea">
        //      carries the aria-label. Set in TextAreaHandler via
        //      `this.textArea.setAttribute("aria-label", ...)`.
        //
        //   2. Modern path (Chrome >= 121, current Chrome Headless): a
        //      <div class="native-edit-context"> with role="textbox",
        //      aria-multiline="true", aria-roledescription="editor"
        //      carries the aria-label. The NativeEditContext also creates
        //      a hidden <textarea class="ime-text-area" aria-hidden="true">
        //      for IME composition - this textarea has NO aria-label and
        //      must NOT be the target of this assertion.
        //
        // Both paths route the option through `ariaLabelForScreenReaderContent`,
        // which returns our `ariaLabel` verbatim when accessibilitySupport
        // is Unknown (0) or Enabled (2), and a localized "editor is not
        // accessible" message when it is Disabled (1).
        //
        // Robust selector: prefer the modern <div role="textbox">, then the
        // legacy <textarea.inputarea>. We focus the editor first because
        // some renders defer screen-reader-content writes until first focus.
        editor!.focus();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const screenReaderEl =
          hostEl.querySelector<HTMLElement>('.monaco-editor .native-edit-context') ??
          hostEl.querySelector<HTMLElement>('.monaco-editor [role="textbox"]') ??
          hostEl.querySelector<HTMLTextAreaElement>('.monaco-editor textarea.inputarea');
        expect(screenReaderEl).not.toBeNull();
        const ariaLabel = screenReaderEl!.getAttribute('aria-label');
        expect(ariaLabel).toBeTruthy();

        const resolvedSupport = editor!.getOption(monaco.editor.EditorOption.accessibilitySupport);
        const DISABLED = 1;
        if (resolvedSupport !== DISABLED) {
          expect(ariaLabel).toBe('JSON editor');
        }
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });
  });

  // --------------------------------------------------------------------
  // M7f-3a: Monaco JSON syntax token theming
  // --------------------------------------------------------------------
  // The component's `defineThemes()` registers `jotjson-dark` and
  // `jotjson-light` with `rules` arrays mapping JSON token scopes to
  // per-theme palette colors. Exact token names are pinned to Monaco
  // 0.55.1's JSON tokenizer (`monaco-editor/esm/vs/language/json/
  // tokenization.js`):
  //   - string.value.json  -> JSON string values
  //   - number.json        -> JSON numbers (NOT plain "number")
  //   - keyword.json       -> true / false / null
  //
  // Strategy: spy on `monaco.editor.defineTheme` BEFORE mounting the
  // fixture, then read the captured arguments. Direct introspection of
  // a registered theme is not exposed by Monaco's public standalone API.
  describe('JSON syntax token theming (M7f-3a)', () => {
    function findThemeData(
      spy: jasmine.Spy,
      name: string,
    ): MonacoNS.editor.IStandaloneThemeData | undefined {
      for (const call of spy.calls.allArgs()) {
        const [registeredName, data] = call as [string, MonacoNS.editor.IStandaloneThemeData];
        if (registeredName === name) {
          return data;
        }
      }
      return undefined;
    }

    function rulesByToken(data: MonacoNS.editor.IStandaloneThemeData): Map<string, string> {
      const map = new Map<string, string>();
      for (const rule of data.rules) {
        if (rule.foreground) map.set(rule.token, rule.foreground.toLowerCase());
      }
      return map;
    }

    it('registers per-theme rules for the JSON tokenizer scopes (jotjson-dark)', async () => {
      const defineThemeSpy = spyOn(monaco.editor, 'defineTheme').and.callThrough();
      const { fixture, hostEl } = await mountSizedFixture('{"a":1}');
      try {
        const data = findThemeData(defineThemeSpy, 'jotjson-dark');
        expect(data)
          .withContext('jotjson-dark theme must be registered via monaco.editor.defineTheme')
          .toBeDefined();
        const rules = rulesByToken(data!);
        expect(rules.get('string.value.json')).toBe('7fa164');
        expect(rules.get('number.json')).toBe('ff9b30');
        expect(rules.get('keyword.json')).toBe('3fa1f3');
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });

    it('registers per-theme rules for the JSON tokenizer scopes (jotjson-light)', async () => {
      const defineThemeSpy = spyOn(monaco.editor, 'defineTheme').and.callThrough();
      const { fixture, hostEl } = await mountSizedFixture('{"a":1}');
      try {
        const data = findThemeData(defineThemeSpy, 'jotjson-light');
        expect(data)
          .withContext('jotjson-light theme must be registered via monaco.editor.defineTheme')
          .toBeDefined();
        const rules = rulesByToken(data!);
        expect(rules.get('string.value.json')).toBe('3f6a25');
        expect(rules.get('number.json')).toBe('8a4b00');
        expect(rules.get('keyword.json')).toBe('005ea8');
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });

    it('inherits the vs / vs-dark base theme so non-rule tokens fall through to Monaco defaults', async () => {
      const defineThemeSpy = spyOn(monaco.editor, 'defineTheme').and.callThrough();
      const { fixture, hostEl } = await mountSizedFixture('{"a":1}');
      try {
        const dark = findThemeData(defineThemeSpy, 'jotjson-dark');
        const light = findThemeData(defineThemeSpy, 'jotjson-light');
        expect(dark!.base).toBe('vs-dark');
        expect(dark!.inherit).toBe(true);
        expect(light!.base).toBe('vs');
        expect(light!.inherit).toBe(true);
      } finally {
        fixture.destroy();
        hostEl.remove();
      }
    });
  });
});
