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

  beforeAll(async () => {
    __resetMonacoLoaderForTesting();
    monaco = await loadMonaco();
  });

  afterAll(() => {
    __resetMonacoLoaderForTesting();
  });

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
});
