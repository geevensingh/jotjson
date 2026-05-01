import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { HomeComponent } from './home.component';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { DraftService } from '../../core/preferences/draft.service';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import { provideRouter, Router } from '@angular/router';
import { BlobService } from '../../core/api/blob.service';
import { AuthService } from '../../core/auth/auth.service';
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { JsonBlob } from '../../core/api/models';
import { MAX_UPLOAD_BYTES } from '../../core/upload/upload-file-validator';
import { DocumentDropController } from '../../core/upload/document-drop-controller.service';
import { DropOverlayComponent } from './file-upload/drop-overlay.component';
import { JsonExtractorService } from '../../core/json/json-extractor.service';
import { LoggerService } from '../../core/telemetry/logger.service';
import { bucketBytes } from '../../core/telemetry/buckets';
import { ExtractJsonBannerComponent } from './extract-json-banner/extract-json-banner.component';
import {
  installMinimalMonacoStub,
  restoreMonacoStub
} from '../../../testing/monaco.testing';

const PREFS_KEY = 'jotjson.preferences.v1';
const DRAFT_KEY = 'jotjson.draft.v1';
const SPLIT_KEY = 'jotjson.splitRatio.v1';
const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';
const SIGN_IN_RESTORE_KEY = 'jotjson.signInRestore.v1';

/**
 * Registers `installMinimalMonacoStub` / `restoreMonacoStub` as
 * before/afterEach hooks on the calling describe. Specs in this file mount
 * `HomeComponent` (some via `detectChanges()`) which embeds
 * `<jj-json-editor>`. Without a stub on `window.monaco`, the editor's
 * lifecycle calls `loadMonaco()` and either fetches the real Monaco AMD
 * loader (slow, mounts real editors in unit specs) or fails noisily
 * (when the asset path is misconfigured). Either way, unit-level home
 * specs do not want to exercise real Monaco - that is the browser
 * integration layer's job. See DESIGN_SPEC.md > Testing strategy.
 */
function setupMinimalMonacoStub(): void {
  beforeEach(() => installMinimalMonacoStub());
  afterEach(() => restoreMonacoStub());
}

function waitForDoubleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function waitForTaskQueue(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function clearHomeStorage(): void {
  localStorage.removeItem(PREFS_KEY);
  localStorage.removeItem(DRAFT_KEY);
  localStorage.removeItem(SPLIT_KEY);
  localStorage.removeItem(PANE_VIS_KEY);
  sessionStorage.removeItem(SIGN_IN_RESTORE_KEY);
}

function makeIdentityBlob(overrides: Partial<JsonBlob> = {}): JsonBlob {
  return {
    id: 'identity-blob-1',
    slug: 'abc123',
    content: '{"saved":true}',
    title: 'Saved title',
    ownerId: 'owner-me',
    isPublic: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  };
}

describe('HomeComponent (unit-level)', () => {
  setupMinimalMonacoStub();
  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
  });

  it('onToggleTheme cycles light -> dark -> system -> light', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ theme: 'light' });

    fixture.componentInstance.onToggleTheme();
    expect(prefs.prefs().theme).toBe('dark');

    fixture.componentInstance.onToggleTheme();
    expect(prefs.prefs().theme).toBe('system');

    fixture.componentInstance.onToggleTheme();
    expect(prefs.prefs().theme).toBe('light');
  });

  // paneLayout is the 4-state derived signal that the toolbar's
  // segmented control reads. It folds paneVisibility +
  // layoutOrientation into one value.
  it('paneLayout reflects paneVisibility + layoutOrientation', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const prefs = TestBed.inject(PreferencesService);

    prefs.update({ layoutOrientation: 'horizontal' });
    c.paneVisibility.set('both');
    expect(c.paneLayout()).toBe('both-horizontal');

    prefs.update({ layoutOrientation: 'vertical' });
    expect(c.paneLayout()).toBe('both-vertical');

    c.paneVisibility.set('editor-only');
    expect(c.paneLayout()).toBe('editor-only');

    c.paneVisibility.set('tree-only');
    expect(c.paneLayout()).toBe('tree-only');
  });

  it('onPaneLayoutChange("editor-only") sets paneVisibility and leaves layoutOrientation', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ layoutOrientation: 'horizontal' });

    c.onPaneLayoutChange('editor-only');
    expect(c.paneVisibility()).toBe('editor-only');
    expect(prefs.prefs().layoutOrientation).toBe('horizontal');
  });

  it('onPaneLayoutChange("tree-only") sets paneVisibility and leaves layoutOrientation', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ layoutOrientation: 'vertical' });

    c.onPaneLayoutChange('tree-only');
    expect(c.paneVisibility()).toBe('tree-only');
    expect(prefs.prefs().layoutOrientation).toBe('vertical');
  });

  it('onPaneLayoutChange("both-horizontal") sets paneVisibility=both AND layoutOrientation=horizontal', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ layoutOrientation: 'vertical' });
    c.paneVisibility.set('editor-only');

    c.onPaneLayoutChange('both-horizontal');
    expect(c.paneVisibility()).toBe('both');
    expect(prefs.prefs().layoutOrientation).toBe('horizontal');
  });

  it('onPaneLayoutChange("both-vertical") sets paneVisibility=both AND layoutOrientation=vertical', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ layoutOrientation: 'horizontal' });
    c.paneVisibility.set('tree-only');

    c.onPaneLayoutChange('both-vertical');
    expect(c.paneVisibility()).toBe('both');
    expect(prefs.prefs().layoutOrientation).toBe('vertical');
  });

  it('onClear() empties content, title, and loadedBlob', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentInstance.title.set('hello');
    fixture.componentInstance.loadedBlob.set({
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    });
    fixture.componentInstance.onClear();
    expect(fixture.componentInstance.content()).toBe('');
    expect(fixture.componentInstance.title()).toBe('');
    expect(fixture.componentInstance.loadedBlob()).toBeNull();
  });

  it('onClear() on /s/:slug does not re-hydrate from a resolved initialBlob (regression)', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const blob: JsonBlob = {
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    };
    fixture.componentRef.setInput('initialBlob', blob);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    // Hydrated.
    expect(fixture.componentInstance.content()).toBe('{"a":1}');
    expect(fixture.componentInstance.title()).toBe('hello');
    expect(fixture.componentInstance.loadedBlob()?.id).toBe('id-1');

    // Simulate Clear while still on /s/:slug (navigation is async so the
    // initialBlob input is still the resolved blob when effects re-run).
    fixture.componentInstance.onClear();
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();

    expect(fixture.componentInstance.content()).toBe('');
    expect(fixture.componentInstance.title()).toBe('');
    expect(fixture.componentInstance.loadedBlob()).toBeNull();
    expect(TestBed.inject(DraftService).content()).toBe('');
  });

  it('onClear() stays cleared across multiple hydrate/clear cycles', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const blob: JsonBlob = {
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    };

    // --- Cycle 1: hydrate from blob, then clear.
    fixture.componentRef.setInput('initialBlob', blob);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.content()).toBe('{"a":1}');

    fixture.componentInstance.onClear();
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.content()).toBe('');
    expect(fixture.componentInstance.loadedBlob()).toBeNull();

    // Simulate leaving /s/:slug: initialBlob input becomes undefined.
    fixture.componentRef.setInput('initialBlob', undefined);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();

    // --- Cycle 2: user revisits /s/:slug (resolver returns a fresh blob
    // object with the same id), hydrate should run again, then clear
    // should stick again.
    const blobAgain: JsonBlob = { ...blob };
    fixture.componentRef.setInput('initialBlob', blobAgain);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.content()).toBe('{"a":1}');
    expect(fixture.componentInstance.loadedBlob()?.id).toBe('id-1');

    fixture.componentInstance.onClear();
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.content()).toBe('');
    expect(fixture.componentInstance.title()).toBe('');
    expect(fixture.componentInstance.loadedBlob()).toBeNull();
    expect(TestBed.inject(DraftService).content()).toBe('');
  });

  it('hydrates from a new initialBlob when switching between /s/:slug targets', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const blob1: JsonBlob = {
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    };
    const blob2: JsonBlob = {
      id: 'id-2',
      slug: 'slug-2',
      content: '{"b":2}',
      title: 'world',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-02-01T00:00:00Z',
      updatedAt: '2024-02-01T00:00:00Z'
    };

    fixture.componentRef.setInput('initialBlob', blob1);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.loadedBlob()?.id).toBe('id-1');

    // Component is reused across same-route param changes; switch inputs.
    fixture.componentRef.setInput('initialBlob', blob2);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.loadedBlob()?.id).toBe('id-2');
    expect(fixture.componentInstance.content()).toBe('{"b":2}');
    expect(fixture.componentInstance.title()).toBe('world');
  });

  it('after onClear, destroying the component and remounting starts empty (regression)', () => {
    // Mirrors the real browser flow: /s/:slug component hydrates from blob,
    // user clicks Clear (which navigates to /), the /s/:slug component is
    // destroyed, a fresh / component is created. The fresh component must
    // NOT read blob content from a stale draft.
    const first = TestBed.createComponent(HomeComponent);
    const blob: JsonBlob = {
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    };
    first.componentRef.setInput('initialBlob', blob);
    first.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    // (We deliberately do not flush effects again here - we want to prove
    // that onClear works even if the component's draft-save effect is
    // cancelled by teardown before it flushes.)
    first.componentInstance.onClear();
    first.destroy();

    // Fresh HomeComponent at /, no initialBlob.
    const second = TestBed.createComponent(HomeComponent);
    expect(second.componentInstance.content()).toBe('');
    expect(second.componentInstance.title()).toBe('');
    expect(second.componentInstance.loadedBlob()).toBeNull();
    expect(TestBed.inject(DraftService).content()).toBe('');
  });

  it('onValueChange() updates content', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.onValueChange('{"x":42}');
    expect(fixture.componentInstance.content()).toBe('{"x":42}');
  });

  it('auto-switches back to json when comments are removed', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('// c\n{"a":1}');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.mode()).toBe('jsonc');
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.mode()).toBe('json');
  });

  it('auto-switches to jsonc when comments appear', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    // Trigger the view-level effects by running change detection on the
    // component instance only (not the template, which would mount Monaco).
    fixture.componentInstance.content.set('// c\n{"a":1}');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.mode()).toBe('jsonc');
  });

  it('does not flip to jsonc for // or /* inside strings', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"url":"https://example.com/foo","glob":"/* star */"}');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.mode()).toBe('json');
  });

  it('detects block comments', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('/* hi */ {"a":1}');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(fixture.componentInstance.mode()).toBe('jsonc');
  });

  describe('onDownload', () => {
    function captureDownloadAnchor(): HTMLAnchorElement {
      const realCreateElement = document.createElement.bind(document);
      const anchor = realCreateElement('a');
      spyOn(anchor, 'click');
      spyOn(document, 'createElement').and.callFake(((tag: string) =>
        tag === 'a' ? anchor : realCreateElement(tag)) as typeof document.createElement);
      spyOn(URL, 'createObjectURL').and.returnValue('blob:fake');
      spyOn(URL, 'revokeObjectURL');
      return anchor;
    }

    it('uses .jsonc extension when content has comments (auto-detected)', () => {
      const fixture = TestBed.createComponent(HomeComponent);
      fixture.componentInstance.content.set('// note\n{"a":1}');
      fixture.componentRef.changeDetectorRef.detectChanges();
      TestBed.flushEffects();
      expect(fixture.componentInstance.mode()).toBe('jsonc');

      const anchor = captureDownloadAnchor();
      fixture.componentInstance.onDownload();

      expect(anchor.download).toBe('jotjson-untitled.jsonc');
    });

    it('uses .json extension for plain JSON content', () => {
      const fixture = TestBed.createComponent(HomeComponent);
      fixture.componentInstance.content.set('{"a":1}');
      fixture.componentRef.changeDetectorRef.detectChanges();
      TestBed.flushEffects();
      expect(fixture.componentInstance.mode()).toBe('json');

      const anchor = captureDownloadAnchor();
      fixture.componentInstance.onDownload();

      expect(anchor.download).toBe('jotjson-untitled.json');
    });
  });

  it('onFormat pretty-prints unformatted JSON', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1,"b":2}');
    fixture.componentInstance.onFormat();
    expect(fixture.componentInstance.content()).toContain('\n');
    expect(fixture.componentInstance.content()).toMatch(/"a":\s*1/);
  });

  it('onMinify collapses whitespace and forces json mode', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{\n  "a": 1\n}');
    fixture.componentInstance.mode.set('jsonc');
    fixture.componentInstance.onMinify();
    expect(fixture.componentInstance.content()).toBe('{"a":1}');
    expect(fixture.componentInstance.mode()).toBe('json');
  });

  it('onMinify is a no-op when parse errors exist', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const broken = '{"a":}';
    fixture.componentInstance.content.set(broken);
    fixture.componentInstance.onMinify();
    expect(fixture.componentInstance.content()).toBe(broken);
  });

  it('onCopy writes the editor text to the clipboard', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(
      Promise.resolve()
    );
    await fixture.componentInstance.onCopy();
    expect(spy).toHaveBeenCalledWith('{"a":1}');
  });

  it('onCopy is a no-op when content is empty', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(
      Promise.resolve()
    );
    await fixture.componentInstance.onCopy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('onCopy swallows clipboard errors', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    spyOn(navigator.clipboard, 'writeText').and.returnValue(
      Promise.reject(new Error('denied'))
    );
    await expectAsync(fixture.componentInstance.onCopy()).toBeResolved();
  });

  it('onPaste auto-unescapes an escaped JSON payload and formats it', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const escaped =
      '{\\r\\n    \\"a\\": 1,\\r\\n    \\"b\\": 2\\r\\n }';
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve(escaped)
    );
    await fixture.componentInstance.onPaste();
    await waitForDoubleAnimationFrame();
    const content = fixture.componentInstance.content();
    // Unescaped + formatted: multiline with indentation.
    expect(content).toContain('\n');
    expect(content).toMatch(/"a":\s*1/);
    expect(content).toMatch(/"b":\s*2/);
  });

  it('onPaste leaves already-valid JSON unchanged (no unescape)', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const text = '{"a":1}';
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve(text));
    await fixture.componentInstance.onPaste();
    await waitForDoubleAnimationFrame();
    expect(fixture.componentInstance.content()).toBe(text);
  });

  it('onPaste emits paste.handle telemetry for valid JSON', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const text = '{"a":1}';
    const sizeBytes = new Blob([text]).size;
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve(text));

    await fixture.componentInstance.onPaste();
    await waitForDoubleAnimationFrame();

    expect(eventSpy).toHaveBeenCalledOnceWith(
      'paste.handle',
      { sizeBytesBucket: bucketBytes(sizeBytes) },
      jasmine.objectContaining({
        sizeBytes,
        clipboardReadMs: jasmine.any(Number),
        parseMs: jasmine.any(Number),
        syncHandlerMs: jasmine.any(Number),
        firstPaintMs: jasmine.any(Number)
      })
    );
  });

  it('onPaste does not emit paste.handle for whitespace-only clipboard text', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('  \n\t  ')
    );

    await fixture.componentInstance.onPaste();
    await waitForDoubleAnimationFrame();

    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('onEditorPaste does not emit paste.handle telemetry', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');

    fixture.componentInstance.onEditorPaste({
      pastedText: '{"a":1}',
      postPasteContent: '{"a":1}',
      postPasteParses: true
    });

    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('onCopyEscaped writes JSON.stringify of content to clipboard', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(
      Promise.resolve()
    );
    await fixture.componentInstance.onCopyEscaped();
    expect(spy).toHaveBeenCalledWith('"{\\"a\\":1}"');
  });

  it('onCopyEscaped is a no-op when content is empty', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(
      Promise.resolve()
    );
    await fixture.componentInstance.onCopyEscaped();
    expect(spy).not.toHaveBeenCalled();
  });

  it('splitRatio defaults to 0.5 and splitStyle reflects orientation', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    expect(c.splitRatio()).toBe(0.5);
    expect(c.splitStyle()['grid-template-columns']).toContain('50.000%');

    TestBed.inject(PreferencesService).update({ layoutOrientation: 'vertical' });
    expect(c.splitStyle()['grid-template-rows']).toContain('50.000%');
    expect(c.splitStyle()['grid-template-columns']).toBeUndefined();
  });

  it('splitRatio persists to localStorage and clamps on rehydrate', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.splitRatio.set(0.75);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(localStorage.getItem(SPLIT_KEY)).toBe('0.75');

    localStorage.setItem(SPLIT_KEY, '0.02');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
    const f2 = TestBed.createComponent(HomeComponent);
    expect(f2.componentInstance.splitRatio()).toBe(0.1);
  });

  // 3-state pane visibility toggle (issue #39).
  it('paneVisibility defaults to "both" when localStorage is empty', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    expect(fixture.componentInstance.paneVisibility()).toBe('both');
  });

  it('paneVisibility rehydrates from localStorage, falling back to "both" for unknown values', () => {
    localStorage.setItem(PANE_VIS_KEY, 'editor-only');
    const f1 = TestBed.createComponent(HomeComponent);
    expect(f1.componentInstance.paneVisibility()).toBe('editor-only');

    localStorage.setItem(PANE_VIS_KEY, 'bogus');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
    const f2 = TestBed.createComponent(HomeComponent);
    expect(f2.componentInstance.paneVisibility()).toBe('both');
  });

  it('onPaneLayoutChange cycles through each segment correctly', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    expect(c.paneVisibility()).toBe('both');
    expect(c.paneLayout()).toBe('both-horizontal');

    c.onPaneLayoutChange('editor-only');
    expect(c.paneVisibility()).toBe('editor-only');
    expect(c.paneLayout()).toBe('editor-only');

    c.onPaneLayoutChange('tree-only');
    expect(c.paneVisibility()).toBe('tree-only');
    expect(c.paneLayout()).toBe('tree-only');

    c.onPaneLayoutChange('both-horizontal');
    expect(c.paneVisibility()).toBe('both');
    expect(c.paneLayout()).toBe('both-horizontal');
  });

  it('splitStyle collapses to a single 1fr track when paneVisibility is not "both"', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;

    c.paneVisibility.set('editor-only');
    expect(c.splitStyle()).toEqual({ 'grid-template-columns': '1fr' });

    c.paneVisibility.set('tree-only');
    expect(c.splitStyle()).toEqual({ 'grid-template-columns': '1fr' });

    TestBed.inject(PreferencesService).update({ layoutOrientation: 'vertical' });
    c.paneVisibility.set('editor-only');
    expect(c.splitStyle()).toEqual({ 'grid-template-rows': '1fr' });
  });

  it('returning to "both" restores the previously saved splitRatio', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    c.splitRatio.set(0.7);

    c.paneVisibility.set('editor-only');
    expect(c.splitStyle()).toEqual({ 'grid-template-columns': '1fr' });
    expect(c.splitRatio()).toBe(0.7);

    c.paneVisibility.set('both');
    expect(c.splitStyle()['grid-template-columns']).toContain('70.000%');
    expect(c.splitRatio()).toBe(0.7);
  });

  it('paneVisibility persists to localStorage on change', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.paneVisibility.set('tree-only');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(localStorage.getItem(PANE_VIS_KEY)).toBe('tree-only');
  });

  it('Ctrl+F is not routed to tree-search when the tree pane is hidden', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const c = fixture.componentInstance;
    const focusSpy = spyOn(
      c as unknown as { focusTreeSearch: () => void },
      'focusTreeSearch'
    );

    c.paneVisibility.set('editor-only');
    const ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true });
    spyOn(ev, 'preventDefault');
    c.onKeydown(ev);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();

    c.paneVisibility.set('both');
    const ev2 = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true });
    spyOn(ev2, 'preventDefault');
    c.onKeydown(ev2);
    expect(focusSpy).toHaveBeenCalled();
    expect(ev2.preventDefault).toHaveBeenCalled();
  });
});

describe('HomeComponent dirty computed (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => clearHomeStorage());

  function createComponent(): HomeComponent {
    return TestBed.createComponent(HomeComponent).componentInstance;
  }

  function loadBlob(component: HomeComponent, jsonBlob: JsonBlob): void {
    component.loadedBlob.set(jsonBlob);
    component.content.set(jsonBlob.content);
    component.title.set(jsonBlob.title ?? '');
  }

  it('returns false when loadedBlob is null for a draft', () => {
    const component = createComponent();
    component.content.set('{"draft":true}');
    component.title.set('Draft title');
    expect(component.dirty()).toBeFalse();
  });

  it('returns false when blob content and title match exactly', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob();
    loadBlob(component, jsonBlob);
    expect(component.dirty()).toBeFalse();
  });

  it('returns true when content differs by one character', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob({ content: '{"saved":"a"}' });
    loadBlob(component, jsonBlob);
    component.content.set('{"saved":"b"}');
    expect(component.dirty()).toBeTrue();
  });

  it('returns true when title differs by one character', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob({ title: 'Saved title' });
    loadBlob(component, jsonBlob);
    component.title.set('Saved titles');
    expect(component.dirty()).toBeTrue();
  });

  it('returns false when content differs only by EOL style', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob({ content: '{\r\n  "saved": true\r\n}' });
    loadBlob(component, jsonBlob);
    component.content.set('{\n  "saved": true\n}');
    expect(component.dirty()).toBeFalse();
  });

  it('returns false when title differs only by surrounding whitespace', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob({ title: 'Saved title' });
    loadBlob(component, jsonBlob);
    component.title.set('  Saved title  ');
    expect(component.dirty()).toBeFalse();
  });

  it('returns false for an untitled blob when local title is empty', () => {
    const component = createComponent();
    const undefinedTitleBlob = makeIdentityBlob({ title: undefined });
    loadBlob(component, undefinedTitleBlob);
    component.title.set('');
    expect(component.dirty()).toBeFalse();

    const nullTitleBlob = {
      ...makeIdentityBlob({ id: 'identity-blob-2' }),
      title: null
    } as unknown as JsonBlob;
    loadBlob(component, nullTitleBlob);
    component.title.set('');
    expect(component.dirty()).toBeFalse();
  });

  it('returns false again after an edit is reverted exactly', () => {
    const component = createComponent();
    const jsonBlob = makeIdentityBlob({ content: '{"saved":true}' });
    loadBlob(component, jsonBlob);
    component.content.set('{"saved":false}');
    expect(component.dirty()).toBeTrue();
    component.content.set(jsonBlob.content);
    component.title.set(jsonBlob.title ?? '');
    expect(component.dirty()).toBeFalse();
  });
});

describe('HomeComponent canSave computed (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => clearHomeStorage());

  function createComponent(signedInUserId: string | null = null): HomeComponent {
    if (signedInUserId !== null) {
      signInFakeUser(TestBed.inject(AuthService), {
        user: { id: signedInUserId, displayName: 'Test User' }
      });
    }
    return TestBed.createComponent(HomeComponent).componentInstance;
  }

  function loadBlob(component: HomeComponent, jsonBlob: JsonBlob): void {
    component.loadedBlob.set(jsonBlob);
    component.content.set(jsonBlob.content);
    component.title.set(jsonBlob.title ?? '');
  }

  it('returns false when anonymous draft has no content', () => {
    const component = createComponent();
    component.content.set('');
    expect(component.canSave()).toBeFalse();
  });

  it('returns false when anonymous draft has content', () => {
    const component = createComponent();
    component.content.set('{"draft":true}');
    expect(component.canSave()).toBeFalse();
  });

  it('returns false when anonymous shared blob has content', () => {
    const component = createComponent();
    loadBlob(component, makeIdentityBlob());
    expect(component.canSave()).toBeFalse();
  });

  it('returns false when signed-in draft has no content', () => {
    const component = createComponent('owner-me');
    component.content.set('   ');
    expect(component.canSave()).toBeFalse();
  });

  it('returns true when signed-in draft has content', () => {
    const component = createComponent('owner-me');
    component.content.set('{"draft":true}');
    expect(component.canSave()).toBeTrue();
  });

  it('returns false when signed-in owner shared blob is clean', () => {
    const component = createComponent('owner-me');
    loadBlob(component, makeIdentityBlob({ ownerId: 'owner-me' }));
    expect(component.canSave()).toBeFalse();
  });

  it('returns true when signed-in owner shared blob has dirty content', () => {
    const component = createComponent('owner-me');
    loadBlob(component, makeIdentityBlob({ ownerId: 'owner-me' }));
    component.content.set('{"saved":false}');
    expect(component.canSave()).toBeTrue();
  });

  it('returns true when signed-in owner shared blob has dirty title', () => {
    const component = createComponent('owner-me');
    loadBlob(component, makeIdentityBlob({ ownerId: 'owner-me' }));
    component.title.set('Changed title');
    expect(component.canSave()).toBeTrue();
  });

  it('returns true when signed-in non-owner shared blob is clean', () => {
    const component = createComponent('viewer-me');
    loadBlob(component, makeIdentityBlob({ ownerId: 'owner-me' }));
    expect(component.canSave()).toBeTrue();
  });

  it('returns true when signed-in non-owner shared blob is dirty', () => {
    const component = createComponent('viewer-me');
    loadBlob(component, makeIdentityBlob({ ownerId: 'owner-me' }));
    component.content.set('{"saved":false}');
    expect(component.canSave()).toBeTrue();
  });
});

describe('HomeComponent sign-in restore (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => clearHomeStorage());

  function hydrateFromResolver(jsonBlob: JsonBlob): HomeComponent {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentRef.setInput('initialBlob', jsonBlob);
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    return fixture.componentInstance;
  }

  it('writes the restore snapshot and calls signIn when sign-in is requested', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const signInSpy = spyOn(TestBed.inject(AuthService), 'signIn');
    component.loadedBlob.set(makeIdentityBlob({ slug: 'abc123' }));
    component.content.set('{"edited":true}');
    component.title.set('Edited title');

    component.onSignInRequested();

    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBe(
      JSON.stringify({
        slug: 'abc123',
        content: '{"edited":true}',
        title: 'Edited title'
      })
    );
    expect(signInSpy).toHaveBeenCalledTimes(1);
  });

  it('restores matching snapshot content and title on init and clears it', () => {
    sessionStorage.setItem(
      SIGN_IN_RESTORE_KEY,
      JSON.stringify({
        slug: 'abc123',
        content: '{"restored":true}',
        title: 'Restored title'
      })
    );

    const component = hydrateFromResolver(
      makeIdentityBlob({
        slug: 'abc123',
        content: '{"resolver":true}',
        title: 'Resolver title'
      })
    );

    expect(component.content()).toBe('{"restored":true}');
    expect(component.title()).toBe('Restored title');
    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBeNull();
  });

  it('clears a mismatched snapshot on init without touching resolver content or title', () => {
    sessionStorage.setItem(
      SIGN_IN_RESTORE_KEY,
      JSON.stringify({
        slug: 'different',
        content: '{"restored":true}',
        title: 'Restored title'
      })
    );

    const component = hydrateFromResolver(
      makeIdentityBlob({
        slug: 'abc123',
        content: '{"resolver":true}',
        title: 'Resolver title'
      })
    );

    expect(component.content()).toBe('{"resolver":true}');
    expect(component.title()).toBe('Resolver title');
    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBeNull();
  });

  it('clears invalid snapshot JSON on init without throwing', () => {
    sessionStorage.setItem(SIGN_IN_RESTORE_KEY, '{not json');

    const component = hydrateFromResolver(
      makeIdentityBlob({
        content: '{"resolver":true}',
        title: 'Resolver title'
      })
    );

    expect(component.content()).toBe('{"resolver":true}');
    expect(component.title()).toBe('Resolver title');
    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBeNull();
  });

  it('uses resolver content and title on init when no snapshot exists', () => {
    const component = hydrateFromResolver(
      makeIdentityBlob({
        content: '{"resolver":true}',
        title: 'Resolver title'
      })
    );

    expect(component.content()).toBe('{"resolver":true}');
    expect(component.title()).toBe('Resolver title');
    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBeNull();
  });
});

describe('HomeComponent draft persistence skip (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => clearHomeStorage());

  function flushComponentEffects(fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>): void {
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
  }

  it('writes draft content when no blob is loaded', () => {
    const draftService = TestBed.inject(DraftService);
    const setSpy = spyOn(draftService, 'set').and.callThrough();
    const fixture = TestBed.createComponent(HomeComponent);
    flushComponentEffects(fixture);
    setSpy.calls.reset();

    fixture.componentInstance.onValueChange('{"draft":true}');
    flushComponentEffects(fixture);

    expect(setSpy).toHaveBeenCalledWith('{"draft":true}');
  });

  it('does not write draft content when a shared blob is loaded', () => {
    const draftService = TestBed.inject(DraftService);
    const setSpy = spyOn(draftService, 'set').and.callThrough();
    const fixture = TestBed.createComponent(HomeComponent);
    flushComponentEffects(fixture);
    setSpy.calls.reset();

    fixture.componentInstance.loadedBlob.set(makeIdentityBlob());
    fixture.componentInstance.onValueChange('{"shared":true}');
    flushComponentEffects(fixture);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('still reads the existing draft when no blob is loaded', () => {
    localStorage.setItem(DRAFT_KEY, '{"existing":true}');

    const fixture = TestBed.createComponent(HomeComponent);

    expect(fixture.componentInstance.loadedBlob()).toBeNull();
    expect(fixture.componentInstance.content()).toBe('{"existing":true}');
  });
});

describe('HomeComponent tree<->editor selection sync (issue #42)', () => {
  setupMinimalMonacoStub();
  // We can't render the full HomeComponent (it would mount Monaco), so
  // these tests stub the `tree` and `editor` viewChild signals directly.
  // viewChild returns a callable signal; replacing the field with a
  // function that returns our fake matches that contract.

  interface TreeStub {
    selectByPathString: jasmine.Spy<(path: string | null) => void>;
    hasPath: jasmine.Spy<(path: string) => boolean>;
  }
  interface EditorStub {
    revealRange: jasmine.Spy<
      (range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      }) => void
    >;
  }

  function setUp(content: string, knownPaths: readonly string[] = ['$']) {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.content.set(content);
    const knownSet = new Set<string>(knownPaths);
    const tree: TreeStub = {
      selectByPathString: jasmine.createSpy('selectByPathString'),
      hasPath: jasmine.createSpy('hasPath').and.callFake((p: string) =>
        knownSet.has(p)
      )
    };
    const editor: EditorStub = {
      revealRange: jasmine.createSpy('revealRange')
    };
    (component as unknown as { tree: () => TreeStub }).tree = () => tree;
    (component as unknown as { editor: () => EditorStub }).editor = () =>
      editor;
    return { fixture, component, tree, editor };
  }

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
  });

  it('cursor in middle of "value" selects matching tree row ($.a)', () => {
    const text = '{"a": "value"}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    // Offset 9 sits inside "value" (the v of value).
    component.onCursorChange({ line: 1, column: 10, offset: 9 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
  });

  it('cursor on top-level primitive selects $', () => {
    const text = '42';
    const { component, tree } = setUp(text, ['$']);
    component.onCursorChange({ line: 1, column: 2, offset: 1 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$');
  });

  it('cursor inside an empty object selects $', () => {
    const text = '{ }';
    const { component, tree } = setUp(text, ['$']);
    // Offset 1 is between the `{` and the space.
    component.onCursorChange({ line: 1, column: 2, offset: 1 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$');
  });

  it('cursor in trailing whitespace clears tree selection', () => {
    const text = '{"a": 1}\n\n';
    const { component, tree } = setUp(text, ['$', '$.a']);
    // Offset 9 is in the trailing newlines outside the AST.
    component.onCursorChange({ line: 2, column: 1, offset: 9 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith(null);
  });

  it('tree click on container property reveals whole "key": <value> block', () => {
    const text = '{"a": {"b": 1}}';
    const { component, editor } = setUp(text, ['$', '$.a', '$.a.b']);
    component.onTreeSelectionChange(['a']);
    // Property "a": <object> spans offsets 1..14 (inclusive of value).
    // Start col 2 (after the leading {); end col 15 (just past `}`).
    expect(editor.revealRange).toHaveBeenCalledOnceWith({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 15
    });
  });

  it('tree click on primitive leaf reveals just the value token', () => {
    const text = '{"a": 42}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    component.onTreeSelectionChange(['a']);
    // Value 42 sits at offset 6, length 2 -> startCol 7, endCol 9.
    expect(editor.revealRange).toHaveBeenCalledOnceWith({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 9
    });
  });

  it('tree click on array element reveals just the value', () => {
    const text = '[10, 20, 30]';
    const { component, editor } = setUp(text, ['$', '$[0]', '$[1]', '$[2]']);
    component.onTreeSelectionChange([1]);
    // Array index 1 -> "20" at offset 5, length 2.
    expect(editor.revealRange).toHaveBeenCalledOnceWith({
      startLineNumber: 1,
      startColumn: 6,
      endLineNumber: 1,
      endColumn: 8
    });
  });

  it('tree clear (path=null) does not call editor.revealRange', () => {
    const text = '{"a": 1}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    component.onTreeSelectionChange(null);
    expect(editor.revealRange).not.toHaveBeenCalled();
  });

  it('editor->tree round-trip does not loop (cursor echo is suppressed)', () => {
    const text = '{"a": 1}';
    const { component, tree, editor } = setUp(text, ['$', '$.a']);
    // User moves cursor into $.a
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
    // Tree emits selectionChange in response - this is the echo.
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).not.toHaveBeenCalled();
  });

  it('tree->editor round-trip does not loop (revealRange echo is suppressed)', () => {
    const text = '{"a": 1}';
    const { component, tree, editor } = setUp(text, ['$', '$.a']);
    // User clicks tree row $.a
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    // Editor's cursor change as a result of revealRange - the echo.
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
  });

  it('two consecutive independent tree clicks reveal both (no stale suppression)', () => {
    const text = '{"a": 1, "b": 2}';
    const { component, editor } = setUp(text, ['$', '$.a', '$.b']);
    component.onTreeSelectionChange(['a']);
    component.onTreeSelectionChange(['b']);
    expect(editor.revealRange).toHaveBeenCalledTimes(2);
  });

  it('with sync OFF: cursor change does NOT call tree.selectByPathString', () => {
    const text = '{"a": 1}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    TestBed.inject(PreferencesService).update({
      treeEditorSelectionSync: false
    });
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
  });

  it('with sync OFF: cursor change still updates the cursor signal (status bar)', () => {
    const text = '{"a": 1}';
    const { component } = setUp(text, ['$', '$.a']);
    TestBed.inject(PreferencesService).update({
      treeEditorSelectionSync: false
    });
    component.onCursorChange({ line: 3, column: 5, offset: 6 });
    expect(component.cursor()).toEqual({ line: 3, column: 5 });
  });

  it('with sync OFF: tree click does NOT call editor.revealRange', () => {
    const text = '{"a": 1}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    TestBed.inject(PreferencesService).update({
      treeEditorSelectionSync: false
    });
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).not.toHaveBeenCalled();
  });

  it('toggling the pref OFF and back ON does not auto-resync; next gesture works', () => {
    const text = '{"a": 1}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    // Off
    component.onToggleSelectionSync();
    expect(
      TestBed.inject(PreferencesService).prefs().treeEditorSelectionSync
    ).toBe(false);
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
    // Back on
    component.onToggleSelectionSync();
    expect(
      TestBed.inject(PreferencesService).prefs().treeEditorSelectionSync
    ).toBe(true);
    // Toggling on did not call selectByPathString of its own.
    expect(tree.selectByPathString).not.toHaveBeenCalled();
    // Next user move re-engages sync.
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
  });

  it('onToggleSelectionSync flips the pref and is the inverse of itself', () => {
    const { component } = setUp('{}', ['$']);
    const prefs = TestBed.inject(PreferencesService);
    expect(prefs.prefs().treeEditorSelectionSync).toBe(true);
    component.onToggleSelectionSync();
    expect(prefs.prefs().treeEditorSelectionSync).toBe(false);
    component.onToggleSelectionSync();
    expect(prefs.prefs().treeEditorSelectionSync).toBe(true);
  });

  it('after content reparse invalidates the path, cursor re-selects in the new structure', () => {
    const text = '{"a": 1}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
    // Content shape changes; offset 6 now lives at $.b in the new tree.
    tree.selectByPathString.calls.reset();
    component.content.set('{"b": 1}');
    tree.hasPath.and.callFake((p) => new Set(['$', '$.b']).has(p));
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.b');
  });

  it('content change clears stale loop-suppression sentinels (regression)', () => {
    // Race: cursor->tree direction sets pendingTreeApply, then content
    // reparse clears the tree's selectedPath asynchronously, so the
    // matching tree selectionChange never arrives. A subsequent user
    // tree click on the same path must NOT be suppressed.
    const text = '{"a": 1}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    // Echo never arrives because reparse clears the tree.
    // Drive content through the public setter to mimic real input.
    component.onValueChange('{"a": 1, "b": 2}');
    // User clicks tree row $.a in the new tree shape.
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).toHaveBeenCalledTimes(1);
  });

  it('toggling sync OFF then ON does not strand a sentinel (regression)', () => {
    const text = '{"a": 1}';
    const { component, tree, editor } = setUp(text, ['$', '$.a']);
    // Tree click sets pendingEditorReveal.
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    // Toggle off before the cursor echo arrives.
    component.onToggleSelectionSync();
    // Cursor echo arrives but is ignored because sync is off.
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
    // Toggle back on. Pending values must have been cleared by the OFF
    // flip, otherwise the next legitimate cursor move at the same path
    // would be stuck.
    component.onToggleSelectionSync();
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
  });

  it('BOM-prefixed content resolves cursor to the correct tree path', () => {
    // \uFEFF + {"a": 1} - editor offset 7 sits inside "a" in full text;
    // parser sees stripped offset 6 which resolves to $.a.
    const text = '\uFEFF{"a": 1}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    component.onCursorChange({ line: 1, column: 8, offset: 7 });
    expect(tree.selectByPathString).toHaveBeenCalledOnceWith('$.a');
  });

  it('BOM-prefixed content reveals the correct value range (offsets shifted by BOM)', () => {
    const text = '\uFEFF{"a": 42}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    component.onTreeSelectionChange(['a']);
    // 42 sits at full-text offset 7, length 2. startCol 8, endCol 10.
    expect(editor.revealRange).toHaveBeenCalledOnceWith({
      startLineNumber: 1,
      startColumn: 8,
      endLineNumber: 1,
      endColumn: 10
    });
  });
});

describe('HomeComponent save() branching (M4a)', () => {
  setupMinimalMonacoStub();
  const blob = (overrides: Partial<JsonBlob> = {}): JsonBlob => ({
    id: 'id-1',
    slug: 'slug-1',
    content: '{"a":1}',
    title: 'Hello',
    ownerId: 'owner-me',
    isPublic: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  });

  interface StubBlobService {
    create: jasmine.Spy;
    update: jasmine.Spy;
    get: jasmine.Spy;
  }

  interface StubQuotaService {
    notifyAutoDeleted: jasmine.Spy;
    notifyQuotaExceededManual: jasmine.Spy;
  }

  function setup(opts: {
    userId: string | null;
    createResult?: JsonBlob | Error | { [key: string]: unknown };
    updateResult?: JsonBlob | Error;
  }): {
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>;
    stub: StubBlobService;
    quota: StubQuotaService;
    router: Router;
  } {
    localStorage.removeItem('jotjson.preferences.v1');
    localStorage.removeItem('jotjson.draft.v1');
    localStorage.removeItem('jotjson.splitRatio.v1');
    localStorage.removeItem('jotjson.paneVisibility.v1');
    TestBed.resetTestingModule();

    const stub: StubBlobService = {
      create: jasmine.createSpy('create').and.callFake(() =>
        opts.createResult instanceof Error
          ? throwError(() => opts.createResult as Error)
          : of(opts.createResult ?? blob())
      ),
      update: jasmine.createSpy('update').and.callFake(() =>
        opts.updateResult instanceof Error
          ? throwError(() => opts.updateResult as Error)
          : of(opts.updateResult ?? blob())
      ),
      get: jasmine.createSpy('get').and.returnValue(of(blob()))
    };

    const quota: StubQuotaService = {
      notifyAutoDeleted: jasmine.createSpy('notifyAutoDeleted').and.resolveTo(),
      notifyQuotaExceededManual: jasmine
        .createSpy('notifyQuotaExceededManual')
        .and.resolveTo()
    };

    const fakeAuth: Partial<AuthService> = {
      user: (() => (opts.userId ? { id: opts.userId, displayName: 'Test' } : null)) as AuthService['user'],
      isSignedIn: (() => !!opts.userId) as AuthService['isSignedIn'],
      isConfigured: true
    };

    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: BlobService, useValue: stub },
        { provide: AuthService, useValue: fakeAuth },
        { provide: QuotaNotificationService, useValue: quota }
      ]
    });

    const fixture = TestBed.createComponent(HomeComponent);
    return { fixture, stub, quota, router: TestBed.inject(Router) };
  }

  it('does nothing when user is not signed in', async () => {
    const { fixture, stub } = setup({ userId: null });
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(stub.create).not.toHaveBeenCalled();
    expect(stub.update).not.toHaveBeenCalled();
  });

  it('does nothing when content is empty', async () => {
    const { fixture, stub } = setup({ userId: 'u1' });
    fixture.componentInstance.content.set('   ');
    await fixture.componentInstance.onSave();
    expect(stub.create).not.toHaveBeenCalled();
  });

  it('create path: signed-in user with no loaded blob calls create, navigates, and emits share.created', async () => {
    const created = blob({ id: 'new-id', slug: 'newslug', ownerId: 'u1' });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    const content = '{"x":1}';
    fixture.componentInstance.content.set(content);
    fixture.componentInstance.title.set('My title');
    await fixture.componentInstance.onSave();
    expect(stub.create).toHaveBeenCalledWith(content, 'My title', false);
    expect(fixture.componentInstance.loadedBlob()).toEqual(created);
    expect(navSpy).toHaveBeenCalledWith(['/s', 'newslug']);
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.created',
      { visibility: 'private' },
      { sizeBytes: new Blob([content]).size }
    );
  });

  it('create path: forks when loaded blob belongs to someone else', async () => {
    const created = blob({ id: 'fork-id', slug: 'forkslug', ownerId: 'u1' });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.loadedBlob.set(blob({ ownerId: 'someone-else' }));
    fixture.componentInstance.content.set('{"forked":true}');
    await fixture.componentInstance.onSave();
    expect(stub.create).toHaveBeenCalled();
    expect(stub.update).not.toHaveBeenCalled();
  });

  it('update path: owner updates in place (same slug, no navigation) without share.created', async () => {
    const updated = blob({ id: 'id-1', slug: 'slug-1', ownerId: 'u1', title: 'New' });
    const { fixture, stub, router } = setup({ userId: 'u1', updateResult: updated });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.loadedBlob.set(blob({ id: 'id-1', ownerId: 'u1' }));
    fixture.componentInstance.content.set('{"a":2}');
    fixture.componentInstance.title.set('New');
    await fixture.componentInstance.onSave();
    expect(stub.update).toHaveBeenCalledWith('id-1', { content: '{"a":2}', title: 'New' });
    expect(stub.create).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
    expect(fixture.componentInstance.loadedBlob()).toEqual(updated);
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('empty title is sent as undefined (no title)', async () => {
    const { fixture, stub } = setup({ userId: 'u1' });
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentInstance.title.set('   ');
    await fixture.componentInstance.onSave();
    expect(stub.create).toHaveBeenCalledWith('{"a":1}', undefined, false);
  });

  it('save sets saveInFlight during request and clears it after', async () => {
    const { fixture } = setup({ userId: 'u1' });
    fixture.componentInstance.content.set('{"a":1}');
    const p = fixture.componentInstance.onSave();
    expect(fixture.componentInstance.saveInFlight()).toBe(true);
    await p;
    expect(fixture.componentInstance.saveInFlight()).toBe(false);
  });

  it('save failure sets saveError and clears saveInFlight', async () => {
    const err = Object.assign(new Error('oops'), { status: 500 });
    const { fixture } = setup({ userId: 'u1', createResult: err });
    spyOn(console, 'warn');
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(fixture.componentInstance.saveError()).toBeTruthy();
    expect(fixture.componentInstance.saveInFlight()).toBe(false);
  });

  it('create path: calls notifyAutoDeleted when the response includes autoDeleted', async () => {
    const created = {
      ...blob({ id: 'new-id', slug: 'newslug', ownerId: 'u1' }),
      autoDeleted: { id: 'old-id', slug: 'oldslug', title: 'Old title' }
    };
    const { fixture, quota, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(quota.notifyAutoDeleted).toHaveBeenCalledWith({
      id: 'old-id',
      slug: 'oldslug',
      title: 'Old title'
    });
    // loadedBlob must NOT carry the autoDeleted marker.
    expect(
      (fixture.componentInstance.loadedBlob() as unknown as Record<string, unknown>)['autoDeleted']
    ).toBeUndefined();
  });

  it('create path: omits notifyAutoDeleted when autoDeleted is absent', async () => {
    const { fixture, quota, router } = setup({ userId: 'u1' });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(quota.notifyAutoDeleted).not.toHaveBeenCalled();
  });

  it('create path: opens the manual-full dialog on 409 quota_exceeded', async () => {
    const err = Object.assign(new Error('quota'), {
      status: 409,
      error: { error: 'Blob quota reached', code: 'quota_exceeded' }
    });
    const { fixture, quota } = setup({ userId: 'u1', createResult: err });
    spyOn(console, 'warn');
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(quota.notifyQuotaExceededManual).toHaveBeenCalled();
    expect(fixture.componentInstance.saveError()).toBeTruthy();
    expect(fixture.componentInstance.saveInFlight()).toBe(false);
  });
});

describe('HomeComponent browser-title effect (M4a)', () => {
  setupMinimalMonacoStub();
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';
  const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  it('resets to homepage title when no blob is loaded', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const titleSvc = TestBed.inject(Title);
    const spy = spyOn(titleSvc, 'setTitle');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(spy).toHaveBeenCalled();
    const lastArg = spy.calls.mostRecent().args[0];
    expect(lastArg).toContain('JotJSON');
  });

  it('uses the blob title when present', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const titleSvc = TestBed.inject(Title);
    const spy = spyOn(titleSvc, 'setTitle');
    fixture.componentInstance.loadedBlob.set({
      id: 'b1',
      slug: 's1',
      content: '{}',
      title: 'My Config',
      ownerId: 'o1',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    });
    fixture.componentInstance.content.set('{}');
    fixture.componentInstance.title.set('My Config');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(spy).toHaveBeenCalledWith('My Config | JotJSON');
  });

  it('falls back to "Untitled" when a blob has no title', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const titleSvc = TestBed.inject(Title);
    const spy = spyOn(titleSvc, 'setTitle');
    fixture.componentInstance.loadedBlob.set({
      id: 'b1',
      slug: 's1',
      content: '{}',
      ownerId: 'o1',
      isPublic: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z'
    });
    fixture.componentInstance.content.set('{}');
    fixture.componentInstance.title.set('');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(spy).toHaveBeenCalledWith('Untitled | JotJSON');
  });
});

describe('HomeComponent document-title dirty indicator (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => clearHomeStorage());

  function flushComponentEffects(fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>): void {
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
  }

  function mostRecentTitle(spy: jasmine.Spy): string {
    return spy.calls.mostRecent().args[0] as string;
  }

  it('adds a star prefix when a loaded blob becomes dirty', () => {
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);
    const jsonBlob = makeIdentityBlob({
      content: '{"saved":true}',
      title: 'Saved title'
    });

    fixture.componentInstance.loadedBlob.set(jsonBlob);
    fixture.componentInstance.content.set('{"saved":false}');
    fixture.componentInstance.title.set('Saved title');
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');
  });

  it('removes the star prefix when dirty content is reverted', () => {
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);
    const jsonBlob = makeIdentityBlob({
      content: '{"saved":true}',
      title: 'Saved title'
    });

    fixture.componentInstance.loadedBlob.set(jsonBlob);
    fixture.componentInstance.content.set('{"saved":false}');
    fixture.componentInstance.title.set('Saved title');
    flushComponentEffects(fixture);
    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');

    fixture.componentInstance.content.set(jsonBlob.content);
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toBe('Saved title | JotJSON');
  });

  it('does not add a star prefix to the draft fallback title', () => {
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);

    fixture.componentInstance.content.set('{"draft":true}');
    fixture.componentInstance.title.set('Draft title');
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toContain(
      'JotJSON - JSON viewer, formatter, and tree explorer'
    );
    expect(mostRecentTitle(titleSpy).startsWith('* ')).toBeFalse();
  });

  it('removes the star prefix after a successful save resets dirty state', async () => {
    const originalBlob = makeIdentityBlob({
      content: '{"saved":true}',
      title: 'Saved title',
      ownerId: 'owner-me'
    });
    const updatedBlob = makeIdentityBlob({
      content: '{"saved":false}',
      title: 'Saved title',
      ownerId: 'owner-me'
    });
    const blobService = {
      create: jasmine.createSpy('create').and.returnValue(of(updatedBlob)),
      update: jasmine.createSpy('update').and.returnValue(of(updatedBlob)),
      get: jasmine.createSpy('get').and.returnValue(of(originalBlob))
    };
    TestBed.overrideProvider(BlobService, { useValue: blobService });
    signInFakeUser(TestBed.inject(AuthService), {
      user: { id: 'owner-me', displayName: 'Owner User' }
    });
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);

    fixture.componentInstance.loadedBlob.set(originalBlob);
    fixture.componentInstance.content.set(updatedBlob.content);
    fixture.componentInstance.title.set('Saved title');
    flushComponentEffects(fixture);
    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');

    await fixture.componentInstance.onSave();
    flushComponentEffects(fixture);

    expect(blobService.update).toHaveBeenCalledWith('identity-blob-1', {
      content: '{"saved":false}',
      title: 'Saved title'
    });
    expect(mostRecentTitle(titleSpy)).toBe('Saved title | JotJSON');
  });
});

describe('HomeComponent blob actions (M4b)', () => {
  setupMinimalMonacoStub();
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';
  const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';

  // setup() installs a stubbed navigator.clipboard via Object.defineProperty
  // because spyOnProperty requires `clipboard` to already be an accessor,
  // which is true on Windows headless Chrome but not on Linux headless
  // Chrome (the CI runner). We capture the original descriptor here and
  // restore it after each test so the unrelated copy/paste specs above
  // (which spyOn the real navigator.clipboard) keep working.
  let originalClipboardDesc: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  });
  afterEach(() => {
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
  });

  const blob = (overrides: Partial<JsonBlob> = {}): JsonBlob => ({
    id: 'blob-1',
    slug: 'abc123',
    content: '{"a":1}',
    ownerId: 'owner-me',
    isPublic: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides
  });

  function setup(opts: {
    userId: string;
    loaded?: JsonBlob;
    updateResult?: JsonBlob | Error;
    deleteResult?: void | Error;
    confirm?: boolean;
    clipboardAvailable?: boolean;
    clipboardFails?: boolean;
  }) {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();

    const stub = {
      create: jasmine.createSpy('create').and.returnValue(of(blob())),
      update: jasmine.createSpy('update').and.callFake(() =>
        opts.updateResult instanceof Error
          ? throwError(() => opts.updateResult as Error)
          : of(opts.updateResult ?? blob())
      ),
      delete: jasmine.createSpy('delete').and.callFake(() =>
        opts.deleteResult instanceof Error
          ? throwError(() => opts.deleteResult as Error)
          : of(undefined)
      ),
      get: jasmine.createSpy('get').and.returnValue(of(blob()))
    };

    const fakeAuth: Partial<AuthService> = {
      user: (() => ({ id: opts.userId, displayName: 'Test' })) as AuthService['user'],
      isSignedIn: (() => true) as AuthService['isSignedIn'],
      isConfigured: true
    };

    const dialogRef = { afterClosed: () => of(!!opts.confirm) };
    const dialog = { open: jasmine.createSpy('open').and.returnValue(dialogRef) };
    const snack = { open: jasmine.createSpy('open') };

    // Stub navigator.clipboard via Object.defineProperty (afterEach above
    // restores the original descriptor). spyOnProperty would be more
    // ergonomic but it requires `clipboard` to already exist as an
    // accessor, which is not the case on Linux headless Chrome.
    let clipboardStub: { writeText: jasmine.Spy } | undefined;
    if (opts.clipboardAvailable === false) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => undefined as unknown as Clipboard
      });
    } else {
      clipboardStub = {
        writeText: jasmine
          .createSpy('writeText')
          .and.returnValue(
            opts.clipboardFails ? Promise.reject(new Error('x')) : Promise.resolve()
          )
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => clipboardStub as unknown as Clipboard
      });
    }

    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: BlobService, useValue: stub },
        { provide: AuthService, useValue: fakeAuth },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack }
      ]
    });

    const fixture = TestBed.createComponent(HomeComponent);
    if (opts.loaded) fixture.componentInstance.loadedBlob.set(opts.loaded);
    return { fixture, stub, dialog, snack, clipboardStub };
  }

  it('onCopyShareLink writes /s/<slug> URL to the clipboard and toasts on success', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob()
    }); 
      fixture.componentInstance.onCopyShareLink();
      // Let the clipboard promise flush.
      await Promise.resolve();
      await Promise.resolve();
      const writeText = (navigator.clipboard as unknown as { writeText: jasmine.Spy }).writeText;
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/s/abc123`
      );
      expect(snack.open).toHaveBeenCalled();
  });

  it('onCopyShareLink toasts an error when the browser lacks clipboard API', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      clipboardAvailable: false
    }); 
      fixture.componentInstance.onCopyShareLink();
      expect(snack.open).toHaveBeenCalled();
  });

  it('onCopyShareLink is a no-op when no blob is loaded', async () => {
    const { fixture, snack } = setup({ userId: 'owner-me' }); 
      fixture.componentInstance.onCopyShareLink();
      expect(snack.open).not.toHaveBeenCalled();
  });

  it('onTogglePublic emits public visibility telemetry after a private-to-public update', async () => {
    const updated = blob({ isPublic: true });
    const { fixture, stub, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ isPublic: false }),
      updateResult: updated
    });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    await fixture.componentInstance.onTogglePublic();
    expect(stub.update).toHaveBeenCalledWith('blob-1', { isPublic: true });
    expect(fixture.componentInstance.loadedBlob()?.isPublic).toBe(true);
    expect(snack.open).toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.visibility.changed',
      { newVisibility: 'public' },
      undefined
    );
  });

  it('onTogglePublic emits private visibility telemetry after a public-to-private update', async () => {
    const updated = blob({ isPublic: false });
    const { fixture, stub, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ isPublic: true }),
      updateResult: updated
    });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    await fixture.componentInstance.onTogglePublic();
    expect(stub.update).toHaveBeenCalledWith('blob-1', { isPublic: false });
    expect(fixture.componentInstance.loadedBlob()?.isPublic).toBe(false);
    expect(snack.open).toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.visibility.changed',
      { newVisibility: 'private' },
      undefined
    );
  });

  it('onTogglePublic toasts an error without visibility telemetry when the update fails', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      updateResult: new Error('nope')
    });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const warnSpy = spyOn(console, 'warn');
    await fixture.componentInstance.onTogglePublic();
    expect(snack.open).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[share.visibility.failed]', {});
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('onTogglePublic does nothing when the user does not own the blob', async () => {
    const { fixture, stub } = setup({
      userId: 'someone-else',
      loaded: blob()
    }); 
      await fixture.componentInstance.onTogglePublic();
      expect(stub.update).not.toHaveBeenCalled();
  });

  it('onDeleteBlob confirms, deletes, clears state, and navigates home', async () => {
    const { fixture, stub, dialog, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ title: 'My Config' }),
      confirm: true
    });
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true); 
      await fixture.componentInstance.onDeleteBlob();
      expect(dialog.open).toHaveBeenCalled();
      expect(stub.delete).toHaveBeenCalledWith('blob-1');
      expect(fixture.componentInstance.loadedBlob()).toBeNull();
      expect(fixture.componentInstance.content()).toBe('');
      expect(fixture.componentInstance.title()).toBe('');
      expect(nav).toHaveBeenCalledWith(['/']);
      expect(snack.open).toHaveBeenCalled();
  });

  it('onDeleteBlob does nothing when the user cancels the confirmation', async () => {
    const { fixture, stub } = setup({
      userId: 'owner-me',
      loaded: blob(),
      confirm: false
    }); 
      await fixture.componentInstance.onDeleteBlob();
      expect(stub.delete).not.toHaveBeenCalled();
      expect(fixture.componentInstance.loadedBlob()).not.toBeNull();
  });

  it('onDeleteBlob toasts an error when delete fails and preserves local state', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      confirm: true,
      deleteResult: new Error('boom')
    });
    spyOn(console, 'warn'); 
      await fixture.componentInstance.onDeleteBlob();
      expect(fixture.componentInstance.loadedBlob()).not.toBeNull();
      expect(snack.open).toHaveBeenCalled();
  });
});

describe('HomeComponent drag-drop upload (M7b)', () => {
  setupMinimalMonacoStub();
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';
  const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';

  class FakeDropController {
    readonly dropActive = signal(false);
    registeredHandler?: (files: readonly File[]) => void;
    readonly dispose = jasmine.createSpy('dispose');
    readonly registerEditorHandler = jasmine
      .createSpy('registerEditorHandler')
      .and.callFake((handler: (files: readonly File[]) => void) => {
        this.registeredHandler = handler;
        return this.dispose;
      });
  }

  function setup() {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    const fakeController = new FakeDropController();
    const snack = { open: jasmine.createSpy('open') };
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: DocumentDropController, useValue: fakeController },
        { provide: MatSnackBar, useValue: snack }
      ]
    });
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentRef.changeDetectorRef.detectChanges();
    return { fixture, fakeController, snack };
  }

  function makeOversizedFile(): File {
    return {
      size: MAX_UPLOAD_BYTES + 1,
      name: 'oversized.json',
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0))
    } as unknown as File;
  }

  function makeRejectingFile(): File {
    return {
      size: 100,
      name: 'rejecting.json',
      text: () => Promise.reject(new Error('boom')),
      arrayBuffer: () => Promise.reject(new Error('boom'))
    } as unknown as File;
  }

  it('toolbar onUpload with oversized file toasts tooLarge, does not mutate content, and does not emit upload.handle', async () => {
    const { fixture, snack } = setup();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const before = fixture.componentInstance.content();
    const warnSpy = spyOn(console, 'warn');
    await fixture.componentInstance.onUpload(makeOversizedFile());
    expect(snack.open).toHaveBeenCalledTimes(1);
    const args = snack.open.calls.mostRecent().args;
    expect(args[0]).toContain('too large');
    expect(fixture.componentInstance.content()).toBe(before);
    expect(warnSpy).toHaveBeenCalledWith('[home.upload.tooLarge]', {
      sizeBytes: MAX_UPLOAD_BYTES + 1
    });
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('toolbar onUpload with a valid file loads content and emits upload.handle with pick source', async () => {
    const { fixture, snack } = setup();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const text = '{"a":1}';
    const file = new File([text], 'sample.json');
    await fixture.componentInstance.onUpload(file);
    await waitForDoubleAnimationFrame();
    expect(fixture.componentInstance.content()).toBe(text);
    expect(snack.open).not.toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'upload.handle',
      { sizeBytesBucket: bucketBytes(file.size), source: 'pick' },
      jasmine.objectContaining({
        sizeBytes: file.size,
        fileReadMs: jasmine.any(Number),
        parseMs: jasmine.any(Number),
        syncHandlerMs: jasmine.any(Number),
        firstPaintMs: jasmine.any(Number)
      })
    );
  });

  it('registers a drop handler with DocumentDropController on init', () => {
    const { fakeController } = setup();
    expect(fakeController.registerEditorHandler).toHaveBeenCalledTimes(1);
    const handler = fakeController.registerEditorHandler.calls.mostRecent().args[0];
    expect(typeof handler).toBe('function');
  });

  it('disposes the registered drop handler on destroy', () => {
    const { fixture, fakeController } = setup();
    expect(fakeController.dispose).not.toHaveBeenCalled();
    fixture.destroy();
    expect(fakeController.dispose).toHaveBeenCalledTimes(1);
  });

  it('drop with a single valid file loads content and emits upload.handle with drag source', async () => {
    const { fixture, fakeController, snack } = setup();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const handler = fakeController.registeredHandler!;
    const text = '{"b":2}';
    const file = {
      size: new Blob([text]).size,
      name: 'b.json',
      text: () => Promise.resolve(text),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer)
    } as unknown as File;
    handler([file]);
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();
    expect(fixture.componentInstance.content()).toBe(text);
    expect(snack.open).not.toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'upload.handle',
      { sizeBytesBucket: bucketBytes(file.size), source: 'drag' },
      jasmine.objectContaining({
        sizeBytes: file.size,
        fileReadMs: jasmine.any(Number),
        parseMs: jasmine.any(Number),
        syncHandlerMs: jasmine.any(Number),
        firstPaintMs: jasmine.any(Number)
      })
    );
  });

  it('drop with multiple files toasts tooMany and does not mutate content', async () => {
    const { fixture, fakeController, snack } = setup();
    const before = fixture.componentInstance.content();
    const file1 = new File(['{"a":1}'], 'a.json');
    const file2 = new File(['{"b":2}'], 'b.json');
    fakeController.registeredHandler!([file1, file2]);
    await Promise.resolve();
    await Promise.resolve();
    expect(snack.open).toHaveBeenCalledTimes(1);
    expect(snack.open.calls.mostRecent().args[0]).toContain('one file');
    expect(fixture.componentInstance.content()).toBe(before);
  });

  it('drop with an oversized file toasts tooLarge', async () => {
    const { fixture, fakeController, snack } = setup();
    const before = fixture.componentInstance.content();
    const warnSpy = spyOn(console, 'warn');
    fakeController.registeredHandler!([makeOversizedFile()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(snack.open).toHaveBeenCalledTimes(1);
    expect(snack.open.calls.mostRecent().args[0]).toContain('too large');
    expect(fixture.componentInstance.content()).toBe(before);
    expect(warnSpy).toHaveBeenCalledWith('[home.upload.tooLarge]', {
      sizeBytes: MAX_UPLOAD_BYTES + 1
    });
  });

  it('drop where File.text() rejects toasts readFailed without upload.handle telemetry', async () => {
    const { fakeController, snack } = setup();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    fakeController.registeredHandler!([makeRejectingFile()]);
    await waitForTaskQueue();
    expect(snack.open).toHaveBeenCalledTimes(1);
    expect(snack.open.calls.mostRecent().args[0]).toContain('Could not read');
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('exposes dropActive that mirrors the controller signal and is bound to the overlay', () => {
    const { fixture, fakeController } = setup();
    expect(fixture.componentInstance.dropActive()).toBe(false);
    fakeController.dropActive.set(true);
    fixture.componentRef.changeDetectorRef.detectChanges();
    expect(fixture.componentInstance.dropActive()).toBe(true);

    const overlayDebug = fixture.debugElement.query(
      (debugEl) => debugEl.componentInstance instanceof DropOverlayComponent
    );
    expect(overlayDebug).toBeTruthy();
    const overlay = overlayDebug.componentInstance as DropOverlayComponent;
    expect(overlay.visible()).toBe(true);

    fakeController.dropActive.set(false);
    fixture.componentRef.changeDetectorRef.detectChanges();
    expect(overlay.visible()).toBe(false);
  });
});


describe('HomeComponent M7p extract-from-mixed-text', () => {
  setupMinimalMonacoStub();
  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
  });

  it('toolbar paste with mixed text shows the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('INFO log {"a":1}')
    );
    const extractor = TestBed.inject(JsonExtractorService);
    spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 1,
      preservesComments: true
    });

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(component.extractBannerVisible()).toBe(true);
    expect(component.extractedCandidate()?.data.blockCount).toBe(1);
  });

  it('toolbar paste with already-valid JSON does NOT show the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('{"a":1}')
    );
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.callThrough();

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(extractSpy).not.toHaveBeenCalled();
    expect(component.extractBannerVisible()).toBe(false);
    expect(component.extractedCandidate()).toBeNull();
  });

  it('native paste with mixed text fires extractor on pastedText only', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 1,
      preservesComments: true
    });

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'prefix INFO log {"a":1}',
      postPasteParses: false
    });

    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledWith('INFO log {"a":1}');
    expect(component.extractBannerVisible()).toBe(true);
  });

  it('native paste with full-buffer-parses skips extractor and clears prior candidate', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: { text: 'stale', blockCount: 1, preservesComments: true },
      sourceVersion: 999,
      source: 'paste'
    });
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.callThrough();

    component.onEditorPaste({
      pastedText: '{"a":1}',
      postPasteContent: '{"a":1}',
      postPasteParses: true
    });

    expect(extractSpy).not.toHaveBeenCalled();
    expect(component.extractedCandidate()).toBeNull();
    expect(component.extractBannerVisible()).toBe(false);
  });

  it('onExtractAccept replaces content and clears the banner', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: { text: '{ "a": 1 }', blockCount: 1, preservesComments: true },
      sourceVersion: 0,
      source: 'paste'
    });
    expect(component.extractBannerVisible()).toBe(true);

    component.onExtractAccept();

    expect(component.content()).toBe('{ "a": 1 }');
    expect(component.extractedCandidate()).toBeNull();
    expect(component.extractBannerVisible()).toBe(false);
  });

  it('onExtractDismiss clears the banner without changing content', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.onValueChange('original text');
    const before = component.content();
    component.extractedCandidate.set({
      data: { text: '{ "a": 1 }', blockCount: 1, preservesComments: true },
      sourceVersion: 999,
      source: 'paste'
    });

    component.onExtractDismiss();

    expect(component.content()).toBe(before);
    expect(component.extractedCandidate()).toBeNull();
    expect(component.extractBannerVisible()).toBe(false);
  });

  it('banner is cleared when content changes by typing', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 1,
      preservesComments: true
    });

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    expect(component.extractBannerVisible()).toBe(true);

    // Simulate the editor's contentChange (typing) path which routes through
    // setContent. setContent now also explicitly clears the candidate (and
    // emits home.extract.banner.dismiss(content.changed) - covered in the
    // telemetry describe), so both the predicate AND the underlying signal
    // report no banner.
    component.onValueChange('user types more');

    expect(component.extractBannerVisible()).toBe(false);
    expect(component.extractedCandidate()).toBeNull();
  });

  it('drag/drop file with mixed text shows the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 1,
      preservesComments: true
    });
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    expect(extractor.extractFromMixedText).toHaveBeenCalledWith(
      'INFO log {"a":1}'
    );
    expect(component.extractBannerVisible()).toBe(true);
    expect(component.extractedCandidate()?.data.blockCount).toBe(1);
  });

  it('file load with already-valid JSON does NOT show the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.callThrough();
    const file = new File(['{"a":1}'], 'data.json', {
      type: 'application/json'
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    expect(extractSpy).not.toHaveBeenCalled();
    expect(component.extractBannerVisible()).toBe(false);
    expect(component.extractedCandidate()).toBeNull();
  });
});

describe('HomeComponent extract-banner telemetry', () => {
  setupMinimalMonacoStub();

  class FakeDropController {
    readonly dropActive = signal(false);
    registeredHandler?: (files: readonly File[]) => void;
    readonly dispose = jasmine.createSpy('dispose');
    readonly registerEditorHandler = jasmine
      .createSpy('registerEditorHandler')
      .and.callFake((handler: (files: readonly File[]) => void) => {
        this.registeredHandler = handler;
        return this.dispose;
      });
  }

  function setupTelemetryBed(): {
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>;
    component: HomeComponent;
    eventSpy: jasmine.Spy;
    extractorSpy: jasmine.Spy;
    drop: FakeDropController;
  } {
    clearHomeStorage();
    TestBed.resetTestingModule();
    const drop = new FakeDropController();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: DocumentDropController, useValue: drop }
      ]
    });
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    const extractorSpy = spyOn(extractor, 'extractFromMixedText').and.returnValue(
      { text: '{ "a": 1 }', blockCount: 2, preservesComments: false }
    );
    fixture.detectChanges();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    return { fixture, component, eventSpy, extractorSpy, drop };
  }

  function bannerCalls(spy: jasmine.Spy): unknown[][] {
    return spy.calls
      .allArgs()
      .filter(
        (args) =>
          typeof args[0] === 'string' &&
          (args[0] as string).startsWith('home.extract.banner.')
      );
  }

  afterEach(() => {
    clearHomeStorage();
  });

  it('toolbar paste fires shown with source="paste"', async () => {
    const { component, eventSpy } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('INFO log {"a":1}')
    );

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(eventSpy).toHaveBeenCalledWith(
      'home.extract.banner.shown',
      { source: 'paste' },
      { blockCount: 2, preservesComments: 0 }
    );
  });

  it('native editor paste fires shown with source="editor.paste"', () => {
    const { component, eventSpy } = setupTelemetryBed();

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });

    expect(eventSpy).toHaveBeenCalledWith(
      'home.extract.banner.shown',
      { source: 'editor.paste' },
      { blockCount: 2, preservesComments: 0 }
    );
  });

  it('Upload pick fires shown with source="upload.pick"', async () => {
    const { component, eventSpy } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    const shownCalls = bannerCalls(eventSpy).filter(
      (args) => args[0] === 'home.extract.banner.shown'
    );
    expect(shownCalls.length).toBe(1);
    expect(shownCalls[0]).toEqual([
      'home.extract.banner.shown',
      { source: 'upload.pick' },
      { blockCount: 2, preservesComments: 0 }
    ]);
  });

  it('drag-drop fires shown with source="upload.drag"', async () => {
    const { eventSpy, drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });
    expect(drop.registeredHandler).toBeDefined();

    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();

    const shownCalls = bannerCalls(eventSpy).filter(
      (args) => args[0] === 'home.extract.banner.shown'
    );
    expect(shownCalls.length).toBe(1);
    expect(shownCalls[0]).toEqual([
      'home.extract.banner.shown',
      { source: 'upload.drag' },
      { blockCount: 2, preservesComments: 0 }
    ]);
  });

  it('onExtractAccept fires accept and does NOT fire dismiss(content.changed)', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    eventSpy.calls.reset();

    component.onExtractAccept();

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('home.extract.banner.accept');
    expect(calls[0][1]).toEqual({ source: 'editor.paste' });
    expect(calls[0][2]).toEqual({ blockCount: 2, preservesComments: 0 });
  });

  it('onExtractDismiss fires dismiss with reason="user.click"', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    eventSpy.calls.reset();

    component.onExtractDismiss();

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      'home.extract.banner.dismiss',
      { source: 'editor.paste', reason: 'user.click' },
      { blockCount: 2 }
    ]);
  });

  it('typing while the banner is visible fires dismiss with reason="content.changed"', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    expect(component.extractBannerVisible()).toBe(true);
    eventSpy.calls.reset();

    component.onValueChange('user types more');

    expect(component.extractBannerVisible()).toBe(false);
    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      'home.extract.banner.dismiss',
      { source: 'editor.paste', reason: 'content.changed' },
      { blockCount: 2 }
    ]);
  });

  it('a second paste replacing a visible banner fires dismiss(old) + shown(new)', async () => {
    const { component, eventSpy, extractorSpy } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('INFO log {"a":1}')
    );
    await component.onPaste();
    await waitForDoubleAnimationFrame();
    expect(component.extractBannerVisible()).toBe(true);
    eventSpy.calls.reset();
    extractorSpy.and.returnValue({
      text: '{ "b": 2 }',
      blockCount: 1,
      preservesComments: true
    });

    component.onEditorPaste({
      pastedText: 'log {"b":2}',
      postPasteContent: 'log {"b":2}',
      postPasteParses: false
    });

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      'home.extract.banner.dismiss',
      { source: 'paste', reason: 'content.changed' },
      { blockCount: 2 }
    ]);
    expect(calls[1]).toEqual([
      'home.extract.banner.shown',
      { source: 'editor.paste' },
      { blockCount: 1, preservesComments: 1 }
    ]);
  });

  it('candidate carries source="paste" only on toolbar Paste path', async () => {
    const { component } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('INFO log {"a":1}')
    );

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(component.extractedCandidate()?.source).toBe('paste');
  });

  it('candidate carries source="editor.paste" on native editor paste', () => {
    const { component } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    expect(component.extractedCandidate()?.source).toBe('editor.paste');
  });

  it('candidate carries source="upload.pick" on Upload-button path', async () => {
    const { component } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });
    await component.onUpload(file);
    await waitForDoubleAnimationFrame();
    expect(component.extractedCandidate()?.source).toBe('upload.pick');
  });

  it('candidate carries source="upload.drag" on drag-drop path', async () => {
    const { component, drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });
    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();
    expect(component.extractedCandidate()?.source).toBe('upload.drag');
  });

  it('toolbar paste auto-focuses the banner Extract button', async () => {
    const focusSpy = spyOn(
      ExtractJsonBannerComponent.prototype,
      'focusExtractButton'
    );
    const { component } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(
      Promise.resolve('INFO log {"a":1}')
    );

    await component.onPaste();
    await waitForDoubleAnimationFrame();
    await waitForTaskQueue();

    expect(focusSpy).toHaveBeenCalled();
  });

  it('native editor paste does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(
      ExtractJsonBannerComponent.prototype,
      'focusExtractButton'
    );
    const { component } = setupTelemetryBed();

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false
    });
    await waitForTaskQueue();

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('Upload pick does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(
      ExtractJsonBannerComponent.prototype,
      'focusExtractButton'
    );
    const { component } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();
    await waitForTaskQueue();

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('drag-drop does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(
      ExtractJsonBannerComponent.prototype,
      'focusExtractButton'
    );
    const { drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain'
    });

    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();

    expect(focusSpy).not.toHaveBeenCalled();
  });
});


describe('HomeComponent upload-error banner (#36)', () => {
  setupMinimalMonacoStub();
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';
  const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';

  class FakeDropController {
    readonly dropActive = signal(false);
    registeredHandler?: (files: readonly File[]) => void;
    readonly dispose = jasmine.createSpy('dispose');
    readonly registerEditorHandler = jasmine
      .createSpy('registerEditorHandler')
      .and.callFake((handler: (files: readonly File[]) => void) => {
        this.registeredHandler = handler;
        return this.dispose;
      });
  }

  function setup() {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    const fakeController = new FakeDropController();
    const snack = { open: jasmine.createSpy('open') };
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: DocumentDropController, useValue: fakeController },
        { provide: MatSnackBar, useValue: snack }
      ]
    });
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentRef.changeDetectorRef.detectChanges();
    return { fixture, fakeController, snack };
  }

  afterEach(async () => {
    await waitForDoubleAnimationFrame();
  });

  it('toolbar onUpload with malformed JSON sets uploadError and loads raw content', async () => {
    const { fixture, snack } = setup();
    const malformed = '{"a": 1, "b": '; // truncated, parse errors
    const file = new File([malformed], 'broken.json');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.content()).toBe(malformed);
    const err = fixture.componentInstance.uploadError();
    expect(err).not.toBeNull();
    expect(err!.filename).toBe('broken.json');
    expect(fixture.componentInstance.uploadErrorVisible()).toBe(true);
    expect(fixture.componentInstance.uploadErrorFilename()).toBe('broken.json');
    expect(snack.open).not.toHaveBeenCalled();
  });

  it('toolbar onUpload with valid JSON does not set uploadError', async () => {
    const { fixture } = setup();
    const file = new File(['{"a":1}'], 'good.json');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.content()).toBe('{"a":1}');
    expect(fixture.componentInstance.uploadError()).toBeNull();
    expect(fixture.componentInstance.uploadErrorVisible()).toBe(false);
  });

  it('0-byte upload does not set uploadError (treated as empty)', async () => {
    const { fixture } = setup();
    const file = new File([''], 'empty.json');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('whitespace-only upload does not set uploadError (empty after trim)', async () => {
    const { fixture } = setup();
    const file = new File(['   \n\t  '], 'whitespace.json');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('onUploadErrorDismiss clears uploadError', async () => {
    const { fixture } = setup();
    const file = new File(['{"a":'], 'broken.json');

    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();

    fixture.componentInstance.onUploadErrorDismiss();
    expect(fixture.componentInstance.uploadError()).toBeNull();
    expect(fixture.componentInstance.uploadErrorVisible()).toBe(false);
  });

  it('typing the content into validity clears uploadError', async () => {
    const { fixture } = setup();
    const file = new File(['{"a":'], 'broken.json');

    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();

    // Simulate the editor's valueChange -> setContent path.
    fixture.componentInstance.onValueChange('{"a":1}');

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('typing while content is still invalid keeps uploadError set', async () => {
    const { fixture } = setup();
    const file = new File(['{"a":'], 'broken.json');

    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();

    // Still malformed after typing.
    fixture.componentInstance.onValueChange('{"a":');

    const err = fixture.componentInstance.uploadError();
    expect(err).not.toBeNull();
    expect(err!.filename).toBe('broken.json');
  });

  it('typing typos into a previously empty editor does NOT set uploadError', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.uploadError()).toBeNull();

    // User types invalid JSON directly (no upload).
    fixture.componentInstance.onValueChange('{"a":');

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('subsequent valid upload clears uploadError from a prior malformed upload', async () => {
    const { fixture } = setup();
    const bad = new File(['{"a":'], 'broken.json');
    const good = new File(['{"a":1}'], 'good.json');

    await fixture.componentInstance.onUpload(bad);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();

    await fixture.componentInstance.onUpload(good);

    expect(fixture.componentInstance.uploadError()).toBeNull();
    expect(fixture.componentInstance.content()).toBe('{"a":1}');
  });

  it('subsequent malformed upload swaps the filename in uploadError', async () => {
    const { fixture } = setup();
    const a = new File(['{"a":'], 'a.json');
    const b = new File(['{"b":'], 'b.json');

    await fixture.componentInstance.onUpload(a);
    expect(fixture.componentInstance.uploadError()?.filename).toBe('a.json');

    await fixture.componentInstance.onUpload(b);

    expect(fixture.componentInstance.uploadError()?.filename).toBe('b.json');
  });

  it('onClear clears uploadError (empty content)', async () => {
    const { fixture } = setup();
    const file = new File(['{"a":'], 'broken.json');

    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();

    // onClear navigates if not at root; mirror the spec's existing pattern of
    // poking setContent through onValueChange to reach the empty state.
    fixture.componentInstance.onValueChange('');

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('drop with malformed file sets uploadError just like the toolbar path', async () => {
    const { fixture, fakeController } = setup();
    const file = {
      size: 5,
      name: 'dropped.json',
      text: () => Promise.resolve('{"a":'),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"a":').buffer)
    } as unknown as File;

    fakeController.registeredHandler!([file]);
    await Promise.resolve();
    await Promise.resolve();

    const err = fixture.componentInstance.uploadError();
    expect(err).not.toBeNull();
    expect(err!.filename).toBe('dropped.json');
    expect(fixture.componentInstance.content()).toBe('{"a":');
  });

  it('drop with valid file does not set uploadError', async () => {
    const { fixture, fakeController } = setup();
    const file = {
      size: 7,
      name: 'good.json',
      text: () => Promise.resolve('{"a":1}'),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"a":1}').buffer)
    } as unknown as File;

    fakeController.registeredHandler!([file]);
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('mixed-text invalid upload surfaces ONLY the extract banner (suppresses upload-error)', async () => {
    const { fixture } = setup();
    // Prose followed by a JSON object - extractor finds the embedded block
    // and offers to extract it. The upload-error banner is suppressed in
    // favor of the more actionable extract banner.
    const mixed = 'log: request received\n{"id":1, "ok":true}\nend of log';
    const file = new File([mixed], 'log.txt');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.extractBannerVisible()).toBe(true);
    expect(fixture.componentInstance.uploadError()).toBeNull();
  });

  it('invalid upload with no extractable block still shows the upload-error banner', async () => {
    const { fixture } = setup();
    // Pure noise that the JSON extractor will not find a block in.
    const garbage = 'xx yy zz no json here';
    const file = new File([garbage], 'noise.txt');

    await fixture.componentInstance.onUpload(file);

    expect(fixture.componentInstance.extractBannerVisible()).toBe(false);
    expect(fixture.componentInstance.uploadError()).not.toBeNull();
    expect(fixture.componentInstance.uploadError()!.filename).toBe('noise.txt');
  });
});

describe('HomeComponent binary upload rejection (#62)', () => {
  setupMinimalMonacoStub();
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';
  const PANE_VIS_KEY = 'jotjson.paneVisibility.v1';

  class FakeDropController {
    readonly dropActive = signal(false);
    registeredHandler?: (files: readonly File[]) => void;
    readonly dispose = jasmine.createSpy('dispose');
    readonly registerEditorHandler = jasmine
      .createSpy('registerEditorHandler')
      .and.callFake((handler: (files: readonly File[]) => void) => {
        this.registeredHandler = handler;
        return this.dispose;
      });
  }

  function setup() {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    const fakeController = new FakeDropController();
    const snack = { open: jasmine.createSpy('open') };
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: DocumentDropController, useValue: fakeController },
        { provide: MatSnackBar, useValue: snack }
      ]
    });
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentRef.changeDetectorRef.detectChanges();
    return { fixture, fakeController, snack };
  }

  afterEach(async () => {
    await waitForDoubleAnimationFrame();
  });

  function pngFile(name = 'logo.png'): File {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
    ]);
    return new File([pngBytes], name, { type: 'image/png' });
  }

  it('toolbar upload of a PNG toasts and does not mutate content', async () => {
    const { fixture, snack } = setup();
    const before = fixture.componentInstance.content();
    await fixture.componentInstance.onUpload(pngFile());
    expect(snack.open).toHaveBeenCalledTimes(1);
    expect(snack.open.calls.mostRecent().args[0]).toContain('does not appear to be a text file');
    expect(fixture.componentInstance.content()).toBe(before);
  });

  it('toolbar binary upload does not set uploadError, extractBanner, or emit upload.handle', async () => {
    const { fixture } = setup();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    await fixture.componentInstance.onUpload(pngFile());
    expect(fixture.componentInstance.uploadError()).toBeNull();
    expect(fixture.componentInstance.extractBannerVisible()).toBe(false);
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('drag-drop binary upload toasts and does not mutate content', async () => {
    const { fixture, fakeController, snack } = setup();
    const before = fixture.componentInstance.content();
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
    ]);
    const fakePng = {
      size: pngBytes.byteLength,
      name: 'dropped.png',
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(pngBytes.buffer)
    } as unknown as File;
    fakeController.registeredHandler!([fakePng]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(snack.open).toHaveBeenCalledTimes(1);
    expect(snack.open.calls.mostRecent().args[0]).toContain('does not appear to be a text file');
    expect(fixture.componentInstance.content()).toBe(before);
  });

  it('subsequent text upload after a binary rejection still works', async () => {
    const { fixture, snack } = setup();
    await fixture.componentInstance.onUpload(pngFile());
    expect(snack.open).toHaveBeenCalledTimes(1);
    const goodFile = new File(['{"after":true}'], 'good.json');
    await fixture.componentInstance.onUpload(goodFile);
    expect(fixture.componentInstance.content()).toBe('{"after":true}');
    // Snackbar from binary upload is still the most recent open call (no toast for the success).
    expect(snack.open).toHaveBeenCalledTimes(1);
  });
});