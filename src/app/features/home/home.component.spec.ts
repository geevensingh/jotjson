import { signal } from '@angular/core';
import { ComponentFixture, fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { By, Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import type { ParseError } from 'jsonc-parser';
import { parse } from 'jsonc-parser';
import { EMPTY, of, Subject, throwError } from 'rxjs';
import { provideFakeAuth, signInFakeUser } from '../../../testing/auth.testing';
import { installMatchMediaStub } from '../../../testing/match-media.testing';
import { installMinimalMonacoStub, restoreMonacoStub } from '../../../testing/monaco.testing';
import { BlobService, type BlobSyncEvent } from '../../core/api/blob.service';
import type { BlobHighlight, JsonBlob } from '../../core/api/models';
import { AuthService } from '../../core/auth/auth.service';
import { BeaconNavigationService } from '../../core/beacons/beacon-navigation.service';
import {
  ClipboardPollingService,
  type ClipboardGrantedReadResult,
  type ClipboardPermissionState,
} from '../../core/clipboard/clipboard-polling.service';
import type { ParseJsonCandidate } from '../../core/json/json-extractor.core';
import { extractFromMixedText as extractFromMixedTextCore } from '../../core/json/json-extractor.core';
import type { ExtractedJson } from '../../core/json/json-extractor.service';
import { JsonExtractorService } from '../../core/json/json-extractor.service';
import { TreeStringExtractorService } from '../../core/json/tree-string-extractor.service';
import { LoadingSplashService } from '../../core/loading-splash/loading-splash.service';
import { DraftService } from '../../core/preferences/draft.service';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import { bucketBytes } from '../../core/telemetry/buckets';
import { LoggerService } from '../../core/telemetry/logger.service';
import { DocumentDropController } from '../../core/upload/document-drop-controller.service';
import { MAX_UPLOAD_BYTES } from '../../core/upload/upload-file-validator';
import {
  JsonTreeComponent,
  type TreeExtractRequest,
} from '../../shared/components/json-tree/json-tree.component';
import {
  ColdBootClipboardBannerComponent,
  type ColdBootClipboardChoice,
} from './cold-boot-clipboard-banner/cold-boot-clipboard-banner.component';
import { ExtractJsonBannerComponent } from './extract-json-banner/extract-json-banner.component';
import { DropOverlayComponent } from './file-upload/drop-overlay.component';
import { EDITOR_COMMIT_DEBOUNCE_MS, HomeComponent } from './home.component';

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
  beforeEach(() => {
    installMinimalMonacoStub();
    sharedMatchMediaHarness = installMatchMediaStub();
    sharedMatchMediaHarness.set('(max-width: 767.98px)', false);
  });
  afterEach(() => {
    restoreMonacoStub();
    sharedMatchMediaHarness?.uninstall();
    sharedMatchMediaHarness = null;
  });
}

let sharedMatchMediaHarness: ReturnType<typeof installMatchMediaStub> | null = null;

function setNarrowViewport(narrow: boolean): void {
  if (!sharedMatchMediaHarness) {
    throw new Error('setupMinimalMonacoStub() must be active to control narrow viewport');
  }
  sharedMatchMediaHarness.set('(max-width: 767.98px)', narrow);
}

function fireNarrowViewport(narrow: boolean): void {
  if (!sharedMatchMediaHarness) {
    throw new Error('setupMinimalMonacoStub() must be active to control narrow viewport');
  }
  sharedMatchMediaHarness.fire('(max-width: 767.98px)', narrow);
}

function waitForSingleAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
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

function attachToBody(fixture: ComponentFixture<unknown>): () => void {
  document.body.appendChild(fixture.nativeElement);
  return () => {
    fixture.nativeElement.remove();
  };
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
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
    fixture.componentInstance.__loadBlobForTesting({
      id: 'id-1',
      slug: 'slug-1',
      content: '{"a":1}',
      title: 'hello',
      ownerId: 'me',
      isPublic: false,
      highlights: [{ path: '$.a', color: '#ffff00', cascade: false }],
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    fixture.componentInstance.onClear();
    expect(fixture.componentInstance.content()).toBe('');
    expect(fixture.componentInstance.title()).toBe('');
    expect(fixture.componentInstance.loadedBlob()).toBeNull();
    expect(fixture.componentInstance.highlights()).toEqual([]);
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
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
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
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
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
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    const blob2: JsonBlob = {
      id: 'id-2',
      slug: 'slug-2',
      content: '{"b":2}',
      title: 'world',
      ownerId: 'me',
      isPublic: false,
      version: 1,
      createdAt: '2024-02-01T00:00:00Z',
      updatedAt: '2024-02-01T00:00:00Z',
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
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
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
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
    await fixture.componentInstance.onCopy();
    expect(spy).toHaveBeenCalledWith('{"a":1}');
  });

  it('onCopy is a no-op when content is empty', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
    await fixture.componentInstance.onCopy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('onCopy swallows clipboard errors', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.reject(new Error('denied')));
    await expectAsync(fixture.componentInstance.onCopy()).toBeResolved();
  });

  it('onPaste auto-unescapes an escaped JSON payload and formats it', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const escaped = '{\\r\\n    \\"a\\": 1,\\r\\n    \\"b\\": 2\\r\\n }';
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve(escaped));
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
        firstPaintMs: jasmine.any(Number),
      }),
    );
  });

  it('onPaste does not emit paste.handle for whitespace-only clipboard text', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('  \n\t  '));

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
      postPasteParses: true,
    });

    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('onEditorPaste emits paste.handle.editor with parseMs=0 when postPasteParses is true', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const pastedText = '{"a":1}';
    const sizeBytes = new Blob([pastedText]).size;

    fixture.componentInstance.onEditorPaste({
      pastedText,
      postPasteContent: pastedText,
      postPasteParses: true,
    });
    await waitForDoubleAnimationFrame();

    const editorCalls = eventSpy.calls
      .allArgs()
      .filter((args) => args[0] === 'paste.handle.editor');
    expect(editorCalls.length).toBe(1);
    expect(editorCalls[0]).toEqual([
      'paste.handle.editor',
      { sizeBytesBucket: bucketBytes(sizeBytes) },
      jasmine.objectContaining({
        sizeBytes,
        parseMs: 0,
        syncHandlerMs: jasmine.any(Number),
        firstPaintMs: jasmine.any(Number),
      }),
    ]);
    // The toolbar-paste contract is untouched: editor path never emits paste.handle.
    expect(eventSpy.calls.allArgs().some((args) => args[0] === 'paste.handle')).toBeFalse();
  });

  it('onEditorPaste emits paste.handle.editor with parseMs>=0 when postPasteParses is false', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const pastedText = 'INFO log {"a":1}';
    const sizeBytes = new Blob([pastedText]).size;

    fixture.componentInstance.onEditorPaste({
      pastedText,
      postPasteContent: pastedText,
      postPasteParses: false,
    });
    await waitForDoubleAnimationFrame();

    const editorCalls = eventSpy.calls
      .allArgs()
      .filter((args) => args[0] === 'paste.handle.editor');
    expect(editorCalls.length).toBe(1);
    const [, props, measurements] = editorCalls[0];
    expect(props).toEqual({ sizeBytesBucket: bucketBytes(sizeBytes) });
    expect(measurements).toEqual(
      jasmine.objectContaining({
        sizeBytes,
        parseMs: jasmine.any(Number),
        syncHandlerMs: jasmine.any(Number),
        firstPaintMs: jasmine.any(Number),
      }),
    );
    // parseMs is the duration of extractFromMixedText; must be non-negative.
    const numericMeasurements = measurements as {
      parseMs: number;
      syncHandlerMs: number;
      firstPaintMs: number;
    };
    expect(numericMeasurements.parseMs).toBeGreaterThanOrEqual(0);
    expect(numericMeasurements.syncHandlerMs).toBeGreaterThanOrEqual(numericMeasurements.parseMs);
    expect(eventSpy.calls.allArgs().some((args) => args[0] === 'paste.handle')).toBeFalse();
  });

  describe('view reset on document replacement', () => {
    function flushHomeEffects(
      fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
    ): void {
      fixture.componentRef.changeDetectorRef.detectChanges();
      TestBed.flushEffects();
    }

    function createComponentWithClipboardText(
      text: string,
    ): ReturnType<typeof TestBed.createComponent<HomeComponent>> {
      const clipboardStub = {
        readForPaste: async () => text,
        checkOnce: async () => undefined,
        startPolling: () => undefined,
        stopPolling: () => undefined,
        permissionState: signal<'prompt'>('prompt').asReadonly(),
        hasJson: signal(false).asReadonly(),
        preview: signal('').asReadonly(),
      } satisfies Partial<ClipboardPollingService>;
      TestBed.overrideProvider(ClipboardPollingService, {
        useValue: clipboardStub,
      });
      return TestBed.createComponent(HomeComponent);
    }

    it('onPaste triggers re-fit on pasted content', async () => {
      const fixture = createComponentWithClipboardText('{"pasted":true}');
      const component = fixture.componentInstance;
      component.onValueChange('{"existing":true}');
      const tokenBeforePaste = component.viewResetTokenValue();

      await component.onPaste();
      await waitForDoubleAnimationFrame();

      expect(component.content()).toBe('{"pasted":true}');
      expect(component.viewResetTokenValue()).toBe(tokenBeforePaste + 1);
    });

    it('onPaste followed by sync onFormat bumps the token exactly once', async () => {
      const escaped = '{\\r\\n    \\"a\\": 1,\\r\\n    \\"b\\": 2\\r\\n }';
      const fixture = createComponentWithClipboardText(escaped);
      const component = fixture.componentInstance;
      const tokenBeforePaste = component.viewResetTokenValue();

      await component.onPaste();
      await waitForDoubleAnimationFrame();

      expect(component.content()).toContain('\n');
      expect(component.content()).toMatch(/"a":\s*1/);
      expect(component.viewResetTokenValue()).toBe(tokenBeforePaste + 1);
    });

    it('onFormat alone does not bump the token', () => {
      const fixture = TestBed.createComponent(HomeComponent);
      const component = fixture.componentInstance;
      component.onValueChange('{"a":1,"b":2}');
      const tokenBeforeFormat = component.viewResetTokenValue();

      component.onFormat();

      expect(component.content()).toContain('\n');
      expect(component.viewResetTokenValue()).toBe(tokenBeforeFormat);
    });

    it('initialBlob re-hydration with a new id triggers a token bump', () => {
      const fixture = TestBed.createComponent(HomeComponent);
      const component = fixture.componentInstance;
      const firstBlob = makeIdentityBlob({
        id: 'blob-a',
        slug: 'slug-a',
        content: '{"a":1}',
        title: 'Blob A',
      });
      const sameIdBlob = makeIdentityBlob({
        id: 'blob-a',
        slug: 'slug-a-again',
        content: '{"a":2}',
        title: 'Blob A again',
      });
      const secondBlob = makeIdentityBlob({
        id: 'blob-b',
        slug: 'slug-b',
        content: '{"b":2}',
        title: 'Blob B',
      });

      fixture.componentRef.setInput('initialBlob', firstBlob);
      flushHomeEffects(fixture);
      const tokenAfterFirstBlob = component.viewResetTokenValue();

      fixture.componentRef.setInput('initialBlob', sameIdBlob);
      flushHomeEffects(fixture);
      expect(component.viewResetTokenValue()).toBe(tokenAfterFirstBlob);
      expect(component.content()).toBe('{"a":1}');

      fixture.componentRef.setInput('initialBlob', secondBlob);
      flushHomeEffects(fixture);

      expect(component.content()).toBe('{"b":2}');
      expect(component.viewResetTokenValue()).toBe(tokenAfterFirstBlob + 1);
    });

    it('onClear bumps the view-reset token and later typing does not bump again', () => {
      const fixture = TestBed.createComponent(HomeComponent);
      const component = fixture.componentInstance;
      component.onValueChange('{"before":true}');
      flushHomeEffects(fixture);
      const tokenBeforeClear = component.viewResetTokenValue();

      expect(() => component.onClear()).not.toThrow();
      flushHomeEffects(fixture);
      expect(component.content()).toBe('');
      expect(component.treeValue()).toBeUndefined();
      // v5: onClear routes through replaceDocument, which bumps the
      // view-reset token so the tree's selection / expansion state
      // is conceptually reset for the now-empty document.
      expect(component.viewResetTokenValue()).toBe(tokenBeforeClear + 1);
      const tokenAfterClear = component.viewResetTokenValue();

      expect(() => component.onValueChange('{"after":true}')).not.toThrow();
      flushHomeEffects(fixture);

      expect(component.content()).toBe('{"after":true}');
      expect(component.treeValue()).toEqual({ after: true });
      // Subsequent typing is on the live setContent path and must
      // not bump the token again.
      expect(component.viewResetTokenValue()).toBe(tokenAfterClear);
    });
  });

  it('onCopyEscaped writes JSON.stringify of content to clipboard', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
    await fixture.componentInstance.onCopyEscaped();
    expect(spy).toHaveBeenCalledWith('"{\\"a\\":1}"');
  });

  it('onCopyEscaped is a no-op when content is empty', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    const spy = spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
    const focusSpy = spyOn(c as unknown as { focusTreeSearch: () => void }, 'focusTreeSearch');

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

/**
 * v5 tree-pane debounce contract (issue: editing perf).
 *
 * The home component now exposes two separate views of `parseResult`:
 *   - Live consumers (`errors`, `dirty`, status bar, Format/Minify,
 *     search) read `parseResult()` directly and update on every
 *     keystroke.
 *   - The tree pane reads `treePaneInputs()` which is a 150 ms-idle
 *     debounced projection.
 *
 * Discrete user actions (`onClear`, `restoreSignInSnapshotOnce`,
 * `onDeleteBlob`, `onExtractRequest`) bypass the timer via
 * `treeFlush$.next()` so the tree pane catches up in the same CD
 * tick. `__flushTreePaneForTesting()` is the spec seam for
 * triggering the same sync flush.
 */
describe('HomeComponent tree-pane debounce (issue: editing perf)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => {
    clearHomeStorage();
  });

  // Spec 1: typing path is debounced once the editor is non-empty.
  // (The empty -> non-empty toggle path is covered by spec 5; this
  // spec specifically guards the steady-state debounce.)
  it('onValueChange does not update treePaneInputs synchronously when editor is non-empty', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();
    // Prime to a non-empty steady state.
    component.onValueChange('{"seed":1}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    const baseline = component.treePaneInputs();
    expect(baseline.value).toEqual({ seed: 1 });

    // A non-empty -> non-empty change is debounced; treePaneInputs
    // stays on the previous reference until the timer elapses.
    component.onValueChange('{"seed":2}');
    fixture.detectChanges();
    expect(component.parseResult().value).toEqual({ seed: 2 });
    expect(component.treePaneInputs()).toBe(baseline);

    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toEqual({ seed: 2 });
  }));

  // Spec 2: debounce window elapses -> tree pane catches up.
  it('treePaneInputs matches parseResult after the debounce window elapses', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.onValueChange('{"after":true}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();

    expect(component.treePaneInputs().value).toEqual({ after: true });
  }));

  // Spec 3: replaceDocument flushes synchronously.
  it('replaceDocument-style discrete swap updates treePaneInputs in the same tick', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.content.set('{"seed":true}');
    component.__flushTreePaneForTesting();
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toEqual({ seed: true });

    // onClear routes through replaceDocument and fires treeFlush$.
    component.onClear();
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toBeUndefined();
    expect(component.content()).toBe('');
  });

  // Spec 4: live consumers stay live (sentinel against accidental debouncing).
  it('live consumers (errors, dirty, parseResult) update on every keystroke', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    component.onValueChange('not-json');
    fixture.detectChanges();
    expect(component.parseResult().errors.length).toBeGreaterThan(0);
    expect(component.errors().length).toBeGreaterThan(0);
    expect(component.dirty()).toBeTrue();
    expect(component.hasContent()).toBeTrue();
  });

  // Spec 5: empty -> non-empty toggle flushes synchronously.
  it('first character into empty editor flushes the tree pane on the empty toggle', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    expect(component.treePaneInputs().value).toBeUndefined();
    component.onValueChange('{"first":1}');
    // Drain the toObservable microtask without ticking the timer.
    flushMicrotasks();
    fixture.detectChanges();

    expect(component.treePaneInputs().value).toEqual({ first: 1 });
    tick(EDITOR_COMMIT_DEBOUNCE_MS); // discharge any pending timer
  }));

  // Spec 6: non-empty -> empty toggle flushes synchronously.
  it('deleting to empty flushes the tree pane on the non-empty -> empty toggle', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.onValueChange('{"x":1}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toEqual({ x: 1 });

    component.onValueChange('');
    flushMicrotasks();
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toBeUndefined();
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
  }));

  // Spec 7: Format/Minify don't visually shift the tree (same shape).
  it('onFormat does not visually shift the tree after debounce (same shape)', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const source = '{"a":1,"b":[2,3]}';
    component.onValueChange(source);
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    const before = component.treePaneInputs().value;

    component.onFormat();
    component.__flushTreePaneForTesting();
    fixture.detectChanges();

    // Same value graph, structurally identical.
    expect(component.treePaneInputs().value).toEqual(before);
    expect(component.content()).not.toBe(source); // text is re-indented
  }));

  // Spec 8: view-reset semantics differ between setContent and replaceDocument.
  it('setContent leaves viewResetToken unchanged; replaceDocument bumps it', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.content.set('{"a":1}');
    fixture.detectChanges();
    const before = component.viewResetTokenValue();

    component.onValueChange('{"a":2}');
    fixture.detectChanges();
    expect(component.viewResetTokenValue()).toBe(before);

    component.onClear(); // replaceDocument path
    fixture.detectChanges();
    expect(component.viewResetTokenValue()).toBe(before + 1);
  });

  // Spec 9: Format with active selection preserves selectedPath.
  // (Phase 1b tree-component contract - signal-level assertion.)
  it('onFormat preserves the existing parseResult shape so tree selection can survive', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.onValueChange('{"users":[{"name":"alice"}]}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    const shapeBefore = component.parseResult().value;

    component.onFormat();
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();

    // Format preserves the parsed value graph (it only re-indents
    // text). The tree-component effect (Phase 1b) reads this graph
    // and decides whether to preserve `selectedPath` based on
    // path resolution against the new tree - identical shape means
    // every prior path still resolves, so selection survives.
    expect(component.parseResult().value).toEqual(shapeBefore);
    expect(component.viewResetTokenValue()).toBe(0);
  }));

  // Spec 10: Extract preserves expansion of other subtrees (no token bump).
  it('onExtractRequest does NOT bump viewResetToken (other subtrees survive)', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    // The real `TreeStringExtractorService` initialises
    // `currentVersion()` to 0 (tree-string-extractor.service.ts:58),
    // so an event with `sourceVersion: 0` passes the staleness gate
    // at home.component.ts:1620 without any mock setup.
    fixture.detectChanges();
    flushMicrotasks();
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","keep":true}');
    component.__flushTreePaneForTesting();
    fixture.detectChanges();
    const tokenBefore = component.viewResetTokenValue();
    expect(component.treeStringExtractor.currentVersion()).toBe(0);

    component.onExtractRequest({
      path: ['payload'],
      sourceVersion: 0,
      replacement: {
        text: '{"a":1}',
        blockCount: 1,
        preservesComments: true,
        proseSegments: 0,
        hasComments: false,
      },
      source: 'rowPillPrimitiveArray',
    });
    fixture.detectChanges();

    // Asserting on `content()` proves the applyEdit flow ran through
    // valueChange and updated the content signal -- the staleness
    // early-return at line 1625 would leave `content()` unchanged
    // and silently pass the token check.
    expect(component.content()).toBe('{"payload":{"a":1},"keep":true}');
    // applyEdit does not bump the token, so any user-expanded
    // sibling subtrees (`keep`, etc.) survive.
    expect(component.viewResetTokenValue()).toBe(tokenBefore);
  }));

  // Spec 11: a Phase 1b regression guard at the home level.
  // After a same-shape edit settles past the debounce window,
  // treePaneInputs.commentsByPath must reference the LATEST
  // parseResult.commentsByPath (not a stale map captured before
  // the edit). The json-tree component spec covers the
  // selection-clear-when-path-gone branch directly; this spec
  // just locks in that the home-side projection rebinds the
  // comments map after a debounced commit.
  it('treePaneInputs.commentsByPath rebinds to the latest parseResult after debounce', fakeAsync(() => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.onValueChange('{"x":1}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    const first = component.parseResult().commentsByPath;
    expect(component.treePaneInputs().commentsByPath).toBe(first);

    component.onValueChange('{"x":2}');
    tick(EDITOR_COMMIT_DEBOUNCE_MS);
    fixture.detectChanges();
    const second = component.parseResult().commentsByPath;
    expect(component.treePaneInputs().commentsByPath).toBe(second);
  }));

  // Spec 12: Extract path flushes tree before expandNodeAtPath runs.
  it('discrete flush + setContent produces the new parseResult synchronously', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.content.set('{"a":{"placeholder":1}}');
    component.__flushTreePaneForTesting();
    fixture.detectChanges();
    expect(component.treePaneInputs().value).toEqual({ a: { placeholder: 1 } });

    // Simulate the body of onExtractRequest: setContent (synchronous
    // content swap on the typing path) + treeFlush$.next() + caller
    // would then invoke expandNodeAtPath against the new tree.
    component.content.set('{"a":{"extracted":42}}');
    component.__flushTreePaneForTesting();
    fixture.detectChanges();

    // The new shape is visible to the tree synchronously - any
    // follow-up `expandNodeAtPath(["a","extracted"])` would resolve.
    expect(component.treePaneInputs().value).toEqual({ a: { extracted: 42 } });
  });

  // Spec 13: first-paint regression guard for users with a hydrated
  // draft. Without seeding `toSignal`'s initialValue from the live
  // parseResult, `pairwise` in `parseResultPath$` would absorb both
  // the `startWith` emission and the bridging effect's first
  // emission (both V0_hydrated, same `.empty`); the switchMap would
  // take the timer branch; and the tree pane would remain blank for
  // ~150 ms before showing the draft on cold load.
  //
  // CRITICAL: this spec must NOT call `tick(...)` or
  // `fixture.detectChanges()` before the assertion. The fix only
  // changes the synchronous initial value; both buggy and fixed
  // pipelines emit the same V0 after the 150 ms timer, so any tick
  // >= 150 would pass either way and silently neuter the regression
  // guard. Future maintainers: do not "helpfully" add detectChanges.
  it('treePaneInputs.value renders a hydrated draft synchronously on first paint', () => {
    localStorage.setItem('jotjson.draft.v1', '{"hello":"world"}');
    const fixture = TestBed.createComponent(HomeComponent);
    expect(fixture.componentInstance.treePaneInputs().value).toEqual({
      hello: 'world',
    });
  });
});

describe('HomeComponent narrow-viewport responsive layout (M7l)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => {
    clearHomeStorage();
  });

  function createHome(narrow: boolean): {
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>;
    c: HomeComponent;
  } {
    setNarrowViewport(narrow);
    const fixture = TestBed.createComponent(HomeComponent);
    return { fixture, c: fixture.componentInstance };
  }

  it('effectivePaneVisibility collapses persisted "both" to "tree-only" only when narrow', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    c.paneVisibility.set('editor-only');
    expect(c.effectivePaneVisibility()).toBe('editor-only');

    c.paneVisibility.set('tree-only');
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    fireNarrowViewport(false);
    c.paneVisibility.set('both');
    expect(c.effectivePaneVisibility()).toBe('both');

    c.paneVisibility.set('editor-only');
    expect(c.effectivePaneVisibility()).toBe('editor-only');

    c.paneVisibility.set('tree-only');
    expect(c.effectivePaneVisibility()).toBe('tree-only');
  });

  it('persisted paneVisibility is never mutated by the narrow override', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.paneVisibility()).toBe('both');
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    fireNarrowViewport(false);
    expect(c.paneVisibility()).toBe('both');
    expect(c.effectivePaneVisibility()).toBe('both');
  });

  it('paneLayout reflects effective (not persisted) visibility at narrow', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.paneLayout()).toBe('tree-only');

    fireNarrowViewport(false);
    expect(c.paneLayout()).toBe('both-horizontal');

    TestBed.inject(PreferencesService).update({ layoutOrientation: 'vertical' });
    expect(c.paneLayout()).toBe('both-vertical');

    fireNarrowViewport(true);
    expect(c.paneLayout()).toBe('tree-only');
  });

  it('splitStyle collapses to a single 1fr track when effective visibility is single-pane at narrow', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.splitStyle()).toEqual({ 'grid-template-columns': '1fr' });

    fireNarrowViewport(false);
    expect(c.splitStyle()['grid-template-columns']).toContain('50.000%');
  });

  it('host element gets .tree-only class at narrow when persisted is "both"', () => {
    const { fixture } = createHome(true);
    fixture.componentInstance.paneVisibility.set('both');
    fixture.detectChanges();
    const split = fixture.nativeElement.querySelector('.split') as HTMLElement | null;
    expect(split?.classList.contains('tree-only')).toBeTrue();
    expect(split?.classList.contains('editor-only')).toBeFalse();
  });

  it('host element honors persisted "editor-only" at narrow', () => {
    const { fixture } = createHome(true);
    fixture.componentInstance.paneVisibility.set('editor-only');
    fixture.detectChanges();
    const split = fixture.nativeElement.querySelector('.split') as HTMLElement | null;
    expect(split?.classList.contains('editor-only')).toBeTrue();
    expect(split?.classList.contains('tree-only')).toBeFalse();
  });

  it('dispatchBeaconJump routes to tree (not the hidden editor) at narrow with persisted "both" + lastActive "editor"', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    const beaconNav = TestBed.inject(BeaconNavigationService);
    beaconNav.markEditorActive();
    expect(beaconNav.lastActivePane()).toBe('editor');

    const tree = jasmine.createSpyObj('JsonTreeComponent', ['selectByPathString']);
    spyOn(c as unknown as { tree: () => unknown }, 'tree').and.returnValue(tree);

    beaconNav.requestJump({ path: ['a', 0], icon: 'warning', source: 'pill' });

    expect(tree.selectByPathString).toHaveBeenCalled();
  });

  it('dispatchBeaconJump still uses lastActivePane when wide with persisted "both"', () => {
    const { c } = createHome(false);
    c.paneVisibility.set('both');
    const beaconNav = TestBed.inject(BeaconNavigationService);
    beaconNav.markEditorActive();

    const tree = jasmine.createSpyObj('JsonTreeComponent', ['selectByPathString']);
    spyOn(c as unknown as { tree: () => unknown }, 'tree').and.returnValue(tree);

    beaconNav.requestJump({ path: ['a', 0], icon: 'warning', source: 'pill' });

    expect(tree.selectByPathString).not.toHaveBeenCalled();
  });

  it('Ctrl+F skips tree-search routing at narrow when persisted is "both" (tree pane is hidden via override)', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    const focusSpy = spyOn(c as unknown as { focusTreeSearch: () => void }, 'focusTreeSearch');
    const ev = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true });
    spyOn(ev, 'preventDefault');
    c.onKeydown(ev);
    expect(focusSpy).toHaveBeenCalled();
    expect(ev.preventDefault).toHaveBeenCalled();
  });

  it('onSplitterPointerDown is a no-op when effective visibility is not "both" at narrow', () => {
    const { c } = createHome(true);
    c.paneVisibility.set('both');
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    const setPointerCapture = jasmine.createSpy('setPointerCapture');
    const addEventListener = jasmine.createSpy('addEventListener');
    const target = {
      setPointerCapture,
      addEventListener,
      removeEventListener: jasmine.createSpy('removeEventListener'),
    } as unknown as HTMLElement;
    const before = c.splitRatio();
    c.onSplitterPointerDown({
      button: 0,
      pointerId: 1,
      currentTarget: target,
      preventDefault: jasmine.createSpy('preventDefault'),
    } as unknown as PointerEvent);

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(c.splitRatio()).toBe(before);
  });

  it('mid-drag move handler bails when narrow flips during drag', () => {
    const { fixture, c } = createHome(false);
    c.paneVisibility.set('both');
    c.splitRatio.set(0.5);
    fixture.detectChanges();
    expect(c.effectivePaneVisibility()).toBe('both');

    const splitHostEl = (
      c as unknown as { splitHost: () => { nativeElement: HTMLElement } | undefined }
    ).splitHost();
    expect(splitHostEl).toBeTruthy();
    spyOn(splitHostEl!.nativeElement, 'getBoundingClientRect').and.returnValue({
      top: 0,
      left: 0,
      right: 1000,
      bottom: 1000,
      width: 1000,
      height: 1000,
      x: 0,
      y: 0,
      toJSON(): unknown {
        return {};
      },
    });

    let moveHandler: ((event: PointerEvent) => void) | null = null;
    const target = {
      setPointerCapture: jasmine.createSpy('setPointerCapture'),
      releasePointerCapture: jasmine.createSpy('releasePointerCapture'),
      addEventListener: jasmine
        .createSpy('addEventListener')
        .and.callFake((type: string, fn: (event: PointerEvent) => void) => {
          if (type === 'pointermove') moveHandler = fn;
        }),
      removeEventListener: jasmine.createSpy('removeEventListener'),
    } as unknown as HTMLElement;

    c.onSplitterPointerDown({
      button: 0,
      pointerId: 1,
      currentTarget: target,
      preventDefault: jasmine.createSpy('preventDefault'),
    } as unknown as PointerEvent);

    expect(moveHandler).withContext('move handler should have been registered').not.toBeNull();

    moveHandler!({ clientX: 700, clientY: 500 } as PointerEvent);
    expect(c.splitRatio()).toBeCloseTo(0.7, 3);

    fireNarrowViewport(true);
    expect(c.effectivePaneVisibility()).toBe('tree-only');

    moveHandler!({ clientX: 200, clientY: 500 } as PointerEvent);
    expect(c.splitRatio()).toBeCloseTo(0.7, 3);
  });
});

describe('cold-boot clipboard auto-paste', () => {
  setupMinimalMonacoStub();

  type HomeFixture = ComponentFixture<HomeComponent>;
  type ReadResult = ClipboardGrantedReadResult;
  type Preference = 'ask' | 'always' | 'never';

  interface DeferredPromise<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
  }

  interface SnackBarStub {
    open: jasmine.Spy<
      (message: string, action?: string, config?: unknown) => MatSnackBarRef<TextOnlySnackBar>
    >;
  }

  interface LoadingSplashStub {
    beginBootstrapHold: jasmine.Spy<(reason: 'coldBootClipboard', maxMs: number) => () => void>;
    markBlobRenderComplete: jasmine.Spy<() => void>;
  }

  interface ColdBootHarness {
    fixture: HomeFixture;
    component: HomeComponent;
    preferences: PreferencesService;
    clipboard: Partial<ClipboardPollingService> & {
      readGrantedClipboardOnce: jasmine.Spy<(reason: 'coldBootAutoPaste') => Promise<ReadResult>>;
      awaitPermissionReady: jasmine.Spy<() => Promise<void>>;
      permissionReadySignal: ReturnType<typeof signal<boolean>>;
      permissionStateSignal: ReturnType<typeof signal<ClipboardPermissionState>>;
    };
    snack: SnackBarStub;
    snackAction: Subject<void>;
    snackRef: MatSnackBarRef<TextOnlySnackBar>;
    loadingSplash: LoadingSplashStub;
    releaseSpies: jasmine.Spy<() => void>[];
    eventSpy: jasmine.Spy<LoggerService['event']>;
  }

  function createDeferredPromise<T>(): DeferredPromise<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    let rejectPromise: ((reason?: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    if (!resolvePromise || !rejectPromise) {
      throw new Error('Deferred promise callbacks were not initialized');
    }
    return { promise, resolve: resolvePromise, reject: rejectPromise };
  }

  function makeSnackBarRef(actionSubject: Subject<void>): MatSnackBarRef<TextOnlySnackBar> {
    const dismissed = new Subject<unknown>();
    const snackRef: Partial<MatSnackBarRef<TextOnlySnackBar>> & {
      __dismissedSubject: Subject<unknown>;
    } = {
      onAction: () => actionSubject.asObservable(),
      afterDismissed: () =>
        dismissed.asObservable() as unknown as ReturnType<
          MatSnackBarRef<TextOnlySnackBar>['afterDismissed']
        >,
      dismiss: jasmine.createSpy('dismiss'),
      __dismissedSubject: dismissed,
    };
    return snackRef as unknown as MatSnackBarRef<TextOnlySnackBar>;
  }

  function createColdBootHarness(
    options: {
      preference?: Preference;
      permissionState?: ClipboardPermissionState;
      permissionReady?: boolean;
      permissionReadyPromise?: Promise<void>;
      readResult?: ReadResult;
      readPromise?: Promise<ReadResult>;
      draft?: string;
      routePath?: string;
      routerUrl?: string;
      initialBlob?: JsonBlob;
    } = {},
  ): ColdBootHarness {
    clearHomeStorage();
    if (options.draft !== undefined) {
      localStorage.setItem(DRAFT_KEY, options.draft);
    }

    TestBed.resetTestingModule();
    const permissionStateSignal = signal<ClipboardPermissionState>(
      options.permissionState ?? 'granted',
    );
    const permissionReadySignal = signal(options.permissionReady ?? true);
    const readResult = options.readResult ?? { ok: true, text: '{"clipboard":true}' };
    const clipboard = {
      permissionStateSignal,
      permissionReadySignal,
      permissionState: permissionStateSignal.asReadonly(),
      permissionReady: permissionReadySignal.asReadonly(),
      hasJson: signal(false).asReadonly(),
      preview: signal('').asReadonly(),
      readGrantedClipboardOnce: jasmine
        .createSpy('readGrantedClipboardOnce')
        .and.callFake(() => options.readPromise ?? Promise.resolve(readResult)),
      awaitPermissionReady: jasmine
        .createSpy('awaitPermissionReady')
        .and.callFake(() => options.permissionReadyPromise ?? Promise.resolve()),
      checkOnce: jasmine.createSpy('checkOnce').and.returnValue(Promise.resolve()),
      startPolling: jasmine.createSpy('startPolling'),
      stopPolling: jasmine.createSpy('stopPolling'),
    } satisfies Partial<ClipboardPollingService> & {
      permissionStateSignal: ReturnType<typeof signal<ClipboardPermissionState>>;
      permissionReadySignal: ReturnType<typeof signal<boolean>>;
      readGrantedClipboardOnce: jasmine.Spy<(reason: 'coldBootAutoPaste') => Promise<ReadResult>>;
      awaitPermissionReady: jasmine.Spy<() => Promise<void>>;
    };

    const releaseSpies: jasmine.Spy<() => void>[] = [];
    const loadingSplash: LoadingSplashStub = {
      beginBootstrapHold: jasmine.createSpy('beginBootstrapHold').and.callFake(() => {
        const release = jasmine.createSpy('releaseColdBootClipboardHold');
        releaseSpies.push(release);
        return release;
      }),
      markBlobRenderComplete: jasmine.createSpy('markBlobRenderComplete'),
    };
    const snackAction = new Subject<void>();
    const snackRef = makeSnackBarRef(snackAction);
    const snack: SnackBarStub = {
      open: jasmine.createSpy('open').and.returnValue(snackRef),
    };
    const activatedRoute = {
      routeConfig: { path: options.routePath ?? '' },
    } satisfies Partial<ActivatedRoute>;

    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: activatedRoute },
        { provide: ClipboardPollingService, useValue: clipboard },
        { provide: LoadingSplashService, useValue: loadingSplash },
        { provide: MatSnackBar, useValue: snack },
      ],
    });

    const preferences = TestBed.inject(PreferencesService);
    preferences.update({ coldBootClipboardAutoPaste: options.preference ?? 'ask' });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const router = TestBed.inject(Router);
    Object.defineProperty(router, 'url', {
      configurable: true,
      get: () => options.routerUrl ?? '/',
    });
    Object.defineProperty(router, 'navigated', {
      configurable: true,
      get: () => false,
    });

    const fixture = TestBed.createComponent(HomeComponent);
    if (options.initialBlob !== undefined) {
      fixture.componentRef.setInput('initialBlob', options.initialBlob);
      fixture.componentRef.changeDetectorRef.detectChanges();
      TestBed.flushEffects();
    }

    return {
      fixture,
      component: fixture.componentInstance,
      preferences,
      clipboard,
      snack,
      snackAction,
      snackRef,
      loadingSplash,
      releaseSpies,
      eventSpy,
    };
  }

  async function flushColdBootEvaluation(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  async function createAskBannerHarness(text = '{"clipboard":true}'): Promise<ColdBootHarness> {
    const harness = createColdBootHarness({
      preference: 'ask',
      draft: '{"draft":true}',
      readResult: { ok: true, text },
    });
    await flushColdBootEvaluation();
    harness.fixture.detectChanges();
    expect(harness.component.coldBootClipboardBannerVisible()).toBeTrue();
    expectBannerCard(harness.fixture, true);
    return harness;
  }

  function expectBannerCard(fixture: HomeFixture, visible: boolean): void {
    fixture.detectChanges();
    const bannerCard = fixture.nativeElement.querySelector(
      'jj-cold-boot-clipboard-banner mat-card',
    ) as HTMLElement | null;
    if (visible) {
      expect(bannerCard).withContext('cold-boot banner card should be visible').not.toBeNull();
    } else {
      expect(bannerCard).withContext('cold-boot banner card should be hidden').toBeNull();
    }
  }

  function emitColdBootChoice(fixture: HomeFixture, choice: ColdBootClipboardChoice): void {
    fixture.detectChanges();
    const bannerDebugElement = fixture.debugElement.query(
      By.directive(ColdBootClipboardBannerComponent),
    );
    expect(bannerDebugElement).withContext('cold-boot banner host should exist').not.toBeNull();
    const banner = bannerDebugElement.componentInstance as ColdBootClipboardBannerComponent;
    banner.choice.emit(choice);
    fixture.detectChanges();
  }

  function sizeBytes(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  function expectColdBootSnack(snack: SnackBarStub): void {
    expect(snack.open).toHaveBeenCalledOnceWith('Pasted from clipboard.', 'Undo', {
      duration: 8000,
    });
  }

  function coldBootTelemetryArgs(eventSpy: jasmine.Spy<LoggerService['event']>): unknown[][] {
    return eventSpy.calls
      .allArgs()
      .filter(([messageId]) => String(messageId).startsWith('home.clipboard.coldBoot.'));
  }

  it('permission ungranted -> evaluator does nothing (no banner, no read, no hold)', async () => {
    const harness = createColdBootHarness({
      preference: 'always',
      permissionState: 'denied',
      permissionReady: true,
    });

    await flushColdBootEvaluation();

    expect(harness.clipboard.awaitPermissionReady).toHaveBeenCalled();
    expect(harness.clipboard.readGrantedClipboardOnce).not.toHaveBeenCalled();
    expect(harness.loadingSplash.beginBootstrapHold).not.toHaveBeenCalled();
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expect(harness.snack.open).not.toHaveBeenCalled();
  });

  it('permission query slow -> evaluator awaits permissionReady before deciding', async () => {
    const permissionDeferred = createDeferredPromise<void>();
    const harness = createColdBootHarness({
      preference: 'always',
      permissionReady: false,
      permissionReadyPromise: permissionDeferred.promise,
    });

    await flushColdBootEvaluation();
    // Before permission is ready, the silent path must not have started.
    expect(harness.loadingSplash.beginBootstrapHold).not.toHaveBeenCalled();
    expect(harness.clipboard.readGrantedClipboardOnce).not.toHaveBeenCalled();

    // Resolve the permission discovery as 'granted'.
    harness.clipboard.permissionReadySignal.set(true);
    permissionDeferred.resolve();
    await flushColdBootEvaluation();

    // Now the silent path proceeds.
    expect(harness.loadingSplash.beginBootstrapHold).toHaveBeenCalledOnceWith(
      'coldBootClipboard',
      150,
    );
    expect(harness.clipboard.readGrantedClipboardOnce).toHaveBeenCalledOnceWith(
      'coldBootAutoPaste',
    );
  });

  it('on /s/:slug (initialBlob input is non-null) -> evaluator never fires', async () => {
    const harness = createColdBootHarness({
      preference: 'ask',
      routePath: 's/:slug',
      routerUrl: '/s/abc123',
      initialBlob: makeIdentityBlob(),
    });

    await flushColdBootEvaluation();

    expect(harness.clipboard.readGrantedClipboardOnce).not.toHaveBeenCalled();
    expect(harness.loadingSplash.beginBootstrapHold).not.toHaveBeenCalled();
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expectBannerCard(harness.fixture, false);
  });

  it('editing a saved blob (loadedBlob is non-null at evaluator start) -> never fires', async () => {
    // Delay permission readiness so we have a window to seed loadedBlob
    // before the cold-boot evaluator clears its first await.
    const permissionDeferred = createDeferredPromise<void>();
    const harness = createColdBootHarness({
      preference: 'always',
      permissionReadyPromise: permissionDeferred.promise,
    });

    harness.component.__loadBlobForTesting(makeIdentityBlob({ content: '{"saved":true}' }));
    permissionDeferred.resolve();
    await flushColdBootEvaluation();

    expect(harness.loadingSplash.beginBootstrapHold).not.toHaveBeenCalled();
    expect(harness.clipboard.readGrantedClipboardOnce).not.toHaveBeenCalled();
    expect(harness.component.content()).toBe('{"saved":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
  });

  it('editing a saved blob mid-evaluation (loadedBlob becomes non-null between read start and apply) -> apply is aborted', async () => {
    const deferredRead = createDeferredPromise<ReadResult>();
    const harness = createColdBootHarness({
      preference: 'ask',
      draft: '{"draft":true}',
      readPromise: deferredRead.promise,
    });

    harness.component.__loadBlobForTesting(makeIdentityBlob({ content: '{"saved":true}' }));
    deferredRead.resolve({ ok: true, text: '{"clipboard":true}' });
    await flushColdBootEvaluation();

    expect(harness.clipboard.readGrantedClipboardOnce).toHaveBeenCalledOnceWith(
      'coldBootAutoPaste',
    );
    expect(harness.component.content()).toBe('{"saved":true}');
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalledWith('home.clipboard.coldBoot.prompt.shown');
  });

  it("preference 'never' -> never fires; no read", async () => {
    const harness = createColdBootHarness({ preference: 'never' });

    await flushColdBootEvaluation();

    expect(harness.clipboard.readGrantedClipboardOnce).not.toHaveBeenCalled();
    expect(harness.loadingSplash.beginBootstrapHold).not.toHaveBeenCalled();
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expectBannerCard(harness.fixture, false);
  });

  it("preference 'ask' + valid object/array JSON -> banner visible; home.clipboard.coldBoot.prompt.shown emitted", async () => {
    const harness = await createAskBannerHarness('[{"clipboard":true}]');

    expect(harness.clipboard.readGrantedClipboardOnce).toHaveBeenCalledOnceWith(
      'coldBootAutoPaste',
    );
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.eventSpy.calls.allArgs()).toEqual([['home.clipboard.coldBoot.prompt.shown']]);
  });

  it("banner Always click -> sets preference to 'always', replaces document, opens Undo snackbar, emits prompt.choice and autoPaste", async () => {
    const clipboardText = '{"clipboard":true}';
    const harness = await createAskBannerHarness(clipboardText);
    harness.eventSpy.calls.reset();

    emitColdBootChoice(harness.fixture, 'always');

    const bytes = sizeBytes(clipboardText);
    expect(harness.preferences.prefs().coldBootClipboardAutoPaste).toBe('always');
    expect(harness.component.content()).toBe(clipboardText);
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expectColdBootSnack(harness.snack);
    expect(coldBootTelemetryArgs(harness.eventSpy)).toEqual([
      ['home.clipboard.coldBoot.prompt.choice', { choice: 'always' }],
      [
        'home.clipboard.coldBoot.autoPaste',
        { sizeBytesBucket: bucketBytes(bytes) },
        { sizeBytes: bytes },
      ],
    ]);
  });

  it('banner Just this time click -> replaces document, opens snackbar, emits prompt.choice, does NOT change preference', async () => {
    const clipboardText = '{"clipboard":true}';
    const harness = await createAskBannerHarness(clipboardText);
    harness.eventSpy.calls.reset();

    emitColdBootChoice(harness.fixture, 'just-this-time');

    expect(harness.preferences.prefs().coldBootClipboardAutoPaste).toBe('ask');
    expect(harness.component.content()).toBe(clipboardText);
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expectColdBootSnack(harness.snack);
    expect(harness.eventSpy.calls.allArgs()).toEqual([
      ['home.clipboard.coldBoot.prompt.choice', { choice: 'just-this-time' }],
    ]);
  });

  it("banner Never click -> sets preference to 'never', no paste, emits prompt.choice", async () => {
    const harness = await createAskBannerHarness();
    harness.eventSpy.calls.reset();

    emitColdBootChoice(harness.fixture, 'never');

    expect(harness.preferences.prefs().coldBootClipboardAutoPaste).toBe('never');
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(coldBootTelemetryArgs(harness.eventSpy)).toEqual([
      ['home.clipboard.coldBoot.prompt.choice', { choice: 'never' }],
    ]);
  });

  it('banner dismiss (X / Esc) -> hides, no preference change, no paste, emits prompt.choice', async () => {
    const harness = await createAskBannerHarness();
    harness.eventSpy.calls.reset();

    emitColdBootChoice(harness.fixture, 'dismiss');

    expect(harness.preferences.prefs().coldBootClipboardAutoPaste).toBe('ask');
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy.calls.allArgs()).toEqual([
      ['home.clipboard.coldBoot.prompt.choice', { choice: 'dismiss' }],
    ]);
  });

  it("preference 'always' + fast read (<150ms) with valid JSON -> silent paste, snackbar, telemetry, splash hold released", async () => {
    const clipboardText = '{"clipboard":true}';
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readResult: { ok: true, text: clipboardText },
    });

    await flushColdBootEvaluation();

    const bytes = sizeBytes(clipboardText);
    expect(harness.loadingSplash.beginBootstrapHold).toHaveBeenCalledOnceWith(
      'coldBootClipboard',
      150,
    );
    expect(harness.releaseSpies[0]).toHaveBeenCalledTimes(1);
    expect(harness.component.content()).toBe(clipboardText);
    expect(harness.component.coldBootClipboardBannerVisible()).toBeFalse();
    expectColdBootSnack(harness.snack);
    expect(harness.eventSpy.calls.allArgs()).toEqual([
      [
        'home.clipboard.coldBoot.autoPaste',
        { sizeBytesBucket: bucketBytes(bytes) },
        { sizeBytes: bytes },
      ],
    ]);
  });

  it("preference 'always' + slow read (>150ms) -> draft hydrates, splash hold released; late-resolving read does not apply", fakeAsync(() => {
    const deferredRead = createDeferredPromise<ReadResult>();
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readPromise: deferredRead.promise,
    });

    expect(harness.component.content()).toBe('{"draft":true}');
    tick(150);
    flushMicrotasks();

    expect(harness.releaseSpies[0]).toHaveBeenCalledTimes(1);
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalled();

    deferredRead.resolve({ ok: true, text: '{"clipboard":true}' });
    flushMicrotasks();

    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalled();
  }));

  it('preference \'always\' + clipboard primitive (e.g. "hi" or 123) -> no paste; JSON-shape gate', async () => {
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readResult: { ok: true, text: '"hi"' },
    });

    await flushColdBootEvaluation();

    expect(harness.releaseSpies[0]).toHaveBeenCalledTimes(1);
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalled();
  });

  it("preference 'always' + clipboard >1MB -> no paste; size gate", async () => {
    const oversizedText = `{"value":"${'x'.repeat(1024 * 1024)}"}`;
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readResult: { ok: true, text: oversizedText },
    });

    await flushColdBootEvaluation();

    expect(sizeBytes(oversizedText)).toBeGreaterThan(1024 * 1024);
    expect(harness.releaseSpies[0]).toHaveBeenCalledTimes(1);
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalled();
  });

  it("preference 'always' + clipboard non-JSON -> no paste", async () => {
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readResult: { ok: true, text: 'not json' },
    });

    await flushColdBootEvaluation();

    expect(harness.releaseSpies[0]).toHaveBeenCalledTimes(1);
    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.snack.open).not.toHaveBeenCalled();
    expect(harness.eventSpy).not.toHaveBeenCalled();
  });

  it('snackbar Undo -> restores prior draft via document replacement; emits autoPaste.undo', async () => {
    const harness = createColdBootHarness({
      preference: 'always',
      draft: '{"draft":true}',
      readResult: { ok: true, text: '{"clipboard":true}' },
    });
    await flushColdBootEvaluation();
    harness.eventSpy.calls.reset();

    harness.snackAction.next();

    expect(harness.component.content()).toBe('{"draft":true}');
    expect(harness.eventSpy.calls.allArgs()).toEqual([['home.clipboard.coldBoot.autoPaste.undo']]);
  });

  it("snackbar reference retained -> verify the cold-boot snackbar's MatSnackBarRef is captured and reachable", async () => {
    const harness = await createAskBannerHarness();
    expect(
      (
        harness.component as unknown as {
          coldBootClipboardSnackRef: MatSnackBarRef<TextOnlySnackBar> | null;
        }
      ).coldBootClipboardSnackRef,
    ).toBeNull();

    emitColdBootChoice(harness.fixture, 'just-this-time');
    await flushColdBootEvaluation();
    harness.fixture.detectChanges();

    const retainedRef = (
      harness.component as unknown as {
        coldBootClipboardSnackRef: MatSnackBarRef<TextOnlySnackBar> | null;
      }
    ).coldBootClipboardSnackRef;
    expect(retainedRef).withContext('SnackBarRef should be retained after paste').not.toBeNull();
    expect(retainedRef).toBe(harness.snackRef);
  });
});

describe('HomeComponent dirty computed (issue #84)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => clearHomeStorage());

  function createComponent(): HomeComponent {
    return TestBed.createComponent(HomeComponent).componentInstance;
  }

  function loadBlob(component: HomeComponent, jsonBlob: JsonBlob): void {
    component.__loadBlobForTesting(jsonBlob);
  }

  it('returns true for an unsaved buffer when the user types content', () => {
    const component = createComponent();
    component.content.set('{"draft":true}');
    expect(component.dirty()).toBeTrue();
  });

  it('returns false after loading a blob without edits', () => {
    const component = createComponent();
    loadBlob(component, makeIdentityBlob());
    expect(component.dirty()).toBeFalse();
  });

  it('returns true when loaded content changes', () => {
    const component = createComponent();
    loadBlob(component, makeIdentityBlob({ content: '{"saved":"a"}' }));
    component.content.set('{"saved":"b"}');
    expect(component.dirty()).toBeTrue();
  });

  it('returns true when loaded title changes', () => {
    const component = createComponent();
    loadBlob(component, makeIdentityBlob({ title: 'Saved title' }));
    component.title.set('Saved titles');
    expect(component.dirty()).toBeTrue();
  });

  it('returns true when a loaded blob gains a highlight', () => {
    const component = createComponent();
    const highlight: BlobHighlight = { path: '$.saved', color: '#ffff00', cascade: false };
    loadBlob(component, makeIdentityBlob());
    component.onHighlightsChange([highlight]);
    expect(component.dirty()).toBeTrue();
  });

  it('returns true when a loaded highlight is removed', () => {
    const component = createComponent();
    const highlight: BlobHighlight = { path: '$.saved', color: '#ffff00', cascade: false };
    loadBlob(component, makeIdentityBlob({ highlights: [highlight] }));
    component.onHighlightsChange([]);
    expect(component.dirty()).toBeTrue();
  });

  it('returns false when a highlight is added and removed back to the loaded state', () => {
    const component = createComponent();
    const highlight: BlobHighlight = { path: '$.saved', color: '#ffff00', cascade: false };
    loadBlob(component, makeIdentityBlob());
    component.onHighlightsChange([highlight]);
    expect(component.dirty()).toBeTrue();
    component.onHighlightsChange([]);
    expect(component.dirty()).toBeFalse();
  });

  it('ignores highlight array order when comparing against the loaded state', () => {
    const component = createComponent();
    const firstHighlight: BlobHighlight = { path: '$.a', color: '#ffff00', cascade: false };
    const secondHighlight: BlobHighlight = { path: '$.b', color: '#00ff00', cascade: true };
    loadBlob(component, makeIdentityBlob({ highlights: [firstHighlight, secondHighlight] }));
    component.onHighlightsChange([secondHighlight, firstHighlight]);
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
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => clearHomeStorage());

  function createComponent(signedInUserId: string | null = null): HomeComponent {
    if (signedInUserId !== null) {
      signInFakeUser(TestBed.inject(AuthService), {
        user: { id: signedInUserId, displayName: 'Test User' },
      });
    }
    return TestBed.createComponent(HomeComponent).componentInstance;
  }

  function loadBlob(component: HomeComponent, jsonBlob: JsonBlob): void {
    component.__loadBlobForTesting(jsonBlob);
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
    component.__loadBlobForTesting(makeIdentityBlob({ slug: 'abc123' }));
    component.content.set('{"edited":true}');
    component.title.set('Edited title');

    component.onSignInRequested();

    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBe(
      JSON.stringify({
        slug: 'abc123',
        content: '{"edited":true}',
        title: 'Edited title',
      }),
    );
    expect(signInSpy).toHaveBeenCalledTimes(1);
  });

  it('restores matching snapshot content and title on init and clears it', () => {
    sessionStorage.setItem(
      SIGN_IN_RESTORE_KEY,
      JSON.stringify({
        slug: 'abc123',
        content: '{"restored":true}',
        title: 'Restored title',
      }),
    );

    const component = hydrateFromResolver(
      makeIdentityBlob({
        slug: 'abc123',
        content: '{"resolver":true}',
        title: 'Resolver title',
      }),
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
        title: 'Restored title',
      }),
    );

    const component = hydrateFromResolver(
      makeIdentityBlob({
        slug: 'abc123',
        content: '{"resolver":true}',
        title: 'Resolver title',
      }),
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
        title: 'Resolver title',
      }),
    );

    expect(component.content()).toBe('{"resolver":true}');
    expect(component.title()).toBe('Resolver title');
    expect(sessionStorage.getItem(SIGN_IN_RESTORE_KEY)).toBeNull();
  });

  it('uses resolver content and title on init when no snapshot exists', () => {
    const component = hydrateFromResolver(
      makeIdentityBlob({
        content: '{"resolver":true}',
        title: 'Resolver title',
      }),
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
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => clearHomeStorage());

  function flushComponentEffects(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
  ): void {
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

    fixture.componentInstance.__loadBlobForTesting(makeIdentityBlob());
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
      providers: [...provideFakeAuth(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.content.set(content);
    const knownSet = new Set<string>(knownPaths);
    const tree: TreeStub = {
      selectByPathString: jasmine.createSpy('selectByPathString'),
      hasPath: jasmine.createSpy('hasPath').and.callFake((p: string) => knownSet.has(p)),
    };
    const editor: EditorStub = {
      revealRange: jasmine.createSpy('revealRange'),
    };
    (component as unknown as { tree: () => TreeStub }).tree = () => tree;
    (component as unknown as { editor: () => EditorStub }).editor = () => editor;
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
      endColumn: 15,
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
      endColumn: 9,
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
      endColumn: 8,
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
      treeEditorSelectionSync: false,
    });
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
  });

  it('with sync OFF: cursor change still updates the cursor signal (status bar)', () => {
    const text = '{"a": 1}';
    const { component } = setUp(text, ['$', '$.a']);
    TestBed.inject(PreferencesService).update({
      treeEditorSelectionSync: false,
    });
    component.onCursorChange({ line: 3, column: 5, offset: 6 });
    expect(component.cursor()).toEqual({ line: 3, column: 5 });
  });

  it('with sync OFF: tree click does NOT call editor.revealRange', () => {
    const text = '{"a": 1}';
    const { component, editor } = setUp(text, ['$', '$.a']);
    TestBed.inject(PreferencesService).update({
      treeEditorSelectionSync: false,
    });
    component.onTreeSelectionChange(['a']);
    expect(editor.revealRange).not.toHaveBeenCalled();
  });

  it('toggling the pref OFF and back ON does not auto-resync; next gesture works', () => {
    const text = '{"a": 1}';
    const { component, tree } = setUp(text, ['$', '$.a']);
    // Off
    component.onToggleSelectionSync();
    expect(TestBed.inject(PreferencesService).prefs().treeEditorSelectionSync).toBe(false);
    component.onCursorChange({ line: 1, column: 7, offset: 6 });
    expect(tree.selectByPathString).not.toHaveBeenCalled();
    // Back on
    component.onToggleSelectionSync();
    expect(TestBed.inject(PreferencesService).prefs().treeEditorSelectionSync).toBe(true);
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
      endColumn: 10,
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
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const sourceHighlight: BlobHighlight = { path: '$.a', color: '#fff59d', cascade: false };

  interface StubBlobService {
    create: jasmine.Spy;
    update: jasmine.Spy;
    get: jasmine.Spy;
    events$: typeof EMPTY;
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
      create: jasmine
        .createSpy('create')
        .and.callFake(() =>
          opts.createResult instanceof Error
            ? throwError(() => opts.createResult as Error)
            : of(opts.createResult ?? blob()),
        ),
      update: jasmine
        .createSpy('update')
        .and.callFake(() =>
          opts.updateResult instanceof Error
            ? throwError(() => opts.updateResult as Error)
            : of(opts.updateResult ?? blob()),
        ),
      get: jasmine.createSpy('get').and.returnValue(of(blob())),
      events$: EMPTY,
    };

    const quota: StubQuotaService = {
      notifyAutoDeleted: jasmine.createSpy('notifyAutoDeleted').and.resolveTo(),
      notifyQuotaExceededManual: jasmine.createSpy('notifyQuotaExceededManual').and.resolveTo(),
    };

    const fakeAuth: Partial<AuthService> = {
      user: (() =>
        opts.userId ? { id: opts.userId, displayName: 'Test' } : null) as AuthService['user'],
      isSignedIn: (() => !!opts.userId) as AuthService['isSignedIn'],
      isConfigured: true,
    };

    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: BlobService, useValue: stub },
        { provide: AuthService, useValue: fakeAuth },
        { provide: QuotaNotificationService, useValue: quota },
      ],
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
    expect(stub.create).toHaveBeenCalledWith(content, 'My title', false, []);
    expect(fixture.componentInstance.loadedBlob()).toEqual(created);
    expect(navSpy).toHaveBeenCalledWith(['/s', 'newslug']);
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.created',
      { visibility: 'private' },
      { sizeBytes: new Blob([content]).size },
    );
  });

  it('create path: forks when loaded blob belongs to someone else', async () => {
    const created = blob({ id: 'fork-id', slug: 'forkslug', ownerId: 'u1' });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.__loadBlobForTesting(blob({ ownerId: 'someone-else' }));
    fixture.componentInstance.content.set('{"forked":true}');
    await fixture.componentInstance.onSave();
    expect(stub.create).toHaveBeenCalled();
    expect(stub.update).not.toHaveBeenCalled();
  });

  it('create path: fork inherits source highlights', async () => {
    const created = blob({
      id: 'fork-id',
      slug: 'forkslug',
      ownerId: 'u1',
      content: '{"a":1}',
      highlights: [sourceHighlight],
    });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.__loadBlobForTesting(
      blob({ content: '{"a":1}', ownerId: 'someone-else', highlights: [sourceHighlight] }),
    );

    await fixture.componentInstance.onSave();

    expect(stub.create).toHaveBeenCalledWith('{"a":1}', 'Hello', false, [sourceHighlight]);
    expect(stub.update).not.toHaveBeenCalled();
    expect(fixture.componentInstance.highlights()).toEqual([sourceHighlight]);
    expect(fixture.componentInstance.canEditHighlights()).toBeTrue();
  });

  it('create path: fork sends an empty highlight list when the source has none', async () => {
    const created = blob({ id: 'fork-id', slug: 'forkslug', ownerId: 'u1' });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.__loadBlobForTesting(
      blob({ content: '{"a":1}', ownerId: 'someone-else' }),
    );

    await fixture.componentInstance.onSave();

    expect(stub.create).toHaveBeenCalledWith('{"a":1}', 'Hello', false, []);
    expect(stub.update).not.toHaveBeenCalled();
    expect(fixture.componentInstance.highlights()).toEqual([]);
  });

  it('create path: fork preserves the maximum highlight list', async () => {
    const sourceHighlights: BlobHighlight[] = [];
    for (let i = 0; i < 100; i += 1) {
      sourceHighlights.push({ path: `$.items[${i}]`, color: '#fff59d', cascade: false });
    }
    const content = `{"items":[${sourceHighlights.map(() => '0').join(',')}]}`;
    const created = blob({
      id: 'fork-id',
      slug: 'forkslug',
      ownerId: 'u1',
      content,
      highlights: sourceHighlights,
    });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.__loadBlobForTesting(
      blob({ content, ownerId: 'someone-else', highlights: sourceHighlights }),
    );

    await fixture.componentInstance.onSave();

    expect(stub.create).toHaveBeenCalledWith(content, 'Hello', false, sourceHighlights);
    expect(stub.update).not.toHaveBeenCalled();
    expect(fixture.componentInstance.highlights()).toEqual(sourceHighlights);
  });

  it('update path: owner updates in place (same slug, no navigation) without share.created', async () => {
    const updated = blob({
      id: 'id-1',
      slug: 'slug-1',
      ownerId: 'u1',
      content: '{"a":2}',
      title: 'New',
    });
    const { fixture, stub, router } = setup({ userId: 'u1', updateResult: updated });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.__loadBlobForTesting(blob({ id: 'id-1', ownerId: 'u1' }));
    fixture.componentInstance.content.set('{"a":2}');
    fixture.componentInstance.title.set('New');
    await fixture.componentInstance.onSave();
    expect(stub.update).toHaveBeenCalledWith('id-1', {
      content: '{"a":2}',
      title: 'New',
      isPublic: false,
      highlights: [],
    });
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
    expect(stub.create).toHaveBeenCalledWith('{"a":1}', undefined, false, []);
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
      autoDeleted: { id: 'old-id', slug: 'oldslug', title: 'Old title' },
    };
    const { fixture, quota, router } = setup({ userId: 'u1', createResult: created });
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.content.set('{"a":1}');
    await fixture.componentInstance.onSave();
    expect(quota.notifyAutoDeleted).toHaveBeenCalledWith({
      id: 'old-id',
      slug: 'oldslug',
      title: 'Old title',
    });
    // loadedBlob must NOT carry the autoDeleted marker.
    expect(
      (fixture.componentInstance.loadedBlob() as unknown as Record<string, unknown>)['autoDeleted'],
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
      error: { error: 'Blob quota reached', code: 'quota_exceeded' },
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

describe('HomeComponent manual highlights save flow (Phase 4)', () => {
  setupMinimalMonacoStub();

  const blob = (overrides: Partial<JsonBlob> = {}): JsonBlob => ({
    id: 'blob-1',
    slug: 'abc123',
    content: '{"foo":1,"bar":2}',
    title: 'Saved title',
    ownerId: 'owner-me',
    isPublic: false,
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const highlightFoo: BlobHighlight = { path: '$.foo', color: '#ffff00', cascade: false };
  const highlightBar: BlobHighlight = { path: '$.bar', color: '#00ff00', cascade: true };

  function setup(
    opts: { userId?: string | null; updateResult?: JsonBlob | Error; dialogResult?: boolean } = {},
  ) {
    clearHomeStorage();
    TestBed.resetTestingModule();

    const eventsSubject = new Subject<BlobSyncEvent>();
    const stub = {
      create: jasmine.createSpy('create').and.returnValue(of(blob())),
      update: jasmine
        .createSpy('update')
        .and.callFake(() =>
          opts.updateResult instanceof Error
            ? throwError(() => opts.updateResult as Error)
            : of(opts.updateResult ?? blob()),
        ),
      get: jasmine.createSpy('get').and.returnValue(of(blob())),
      events$: eventsSubject.asObservable(),
    };
    const fakeAuth: Partial<AuthService> = {
      user: (() =>
        opts.userId === null
          ? null
          : {
              id: opts.userId ?? 'owner-me',
              displayName: 'Test User',
            }) as AuthService['user'],
      isSignedIn: (() => opts.userId !== null) as AuthService['isSignedIn'],
      isConfigured: true,
    };
    const dialogRef = { afterClosed: () => of(opts.dialogResult === true) };
    const dialog = { open: jasmine.createSpy('open').and.returnValue(dialogRef) };
    const snack = { open: jasmine.createSpy('open') };
    const quota = {
      notifyAutoDeleted: jasmine.createSpy('notifyAutoDeleted').and.resolveTo(),
      notifyQuotaExceededManual: jasmine.createSpy('notifyQuotaExceededManual').and.resolveTo(),
    };

    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        provideRouter([]),
        { provide: BlobService, useValue: stub },
        { provide: AuthService, useValue: fakeAuth },
        { provide: MatDialog, useValue: dialog },
        { provide: MatSnackBar, useValue: snack },
        { provide: QuotaNotificationService, useValue: quota },
      ],
    });

    const fixture = TestBed.createComponent(HomeComponent);
    return { fixture, stub, eventsSubject, dialog, snack };
  }

  afterEach(() => {
    closeOpenTreeMenus();
    clearHomeStorage();
    // Detach any HomeComponent host appended by openTreeMenuForPath.
    // The spec leaves the host attached so cdk-virtual-scroll-viewport
    // can measure dimensions; this afterEach cleans the body between
    // specs to avoid cross-test DOM pollution.
    document.body.querySelectorAll('jj-home').forEach((node) => node.remove());
  });

  function getTree(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
  ): JsonTreeComponent {
    return fixture.debugElement.query(By.directive(JsonTreeComponent))
      .componentInstance as JsonTreeComponent;
  }

  function closeOpenTreeMenus(): void {
    document.body
      .querySelectorAll('.cdk-overlay-backdrop')
      .forEach((backdrop) => (backdrop as HTMLElement).click());
  }

  async function openTreeMenuForPath(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
    path: string,
  ): Promise<void> {
    closeOpenTreeMenus();
    // The Phase 2 (issue #95) virtualization of `JsonTreeComponent`
    // requires the host element be attached to the DOM with explicit
    // dimensions; otherwise `<cdk-virtual-scroll-viewport>` renders no
    // rows and queries for `.tree-row[data-path="..."]` return null.
    const host = fixture.nativeElement as HTMLElement;
    if (!host.isConnected) {
      host.style.height = '600px';
      host.style.width = '1000px';
      document.body.appendChild(host);
    }
    fixture.detectChanges();
    const tree = getTree(fixture);
    tree.expandAll();
    fixture.detectChanges();
    // Two microtask drains let cdk-virtual-scroll-viewport's deferred
    // _setRenderedRange Promise.resolve().then(...) settle before the
    // querySelector below runs.
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    const kebab = host.querySelector<HTMLButtonElement>(
      `.tree-row[data-path="${path}"] .tree-kebab-pill`,
    );
    expect(kebab).withContext(`found a kebab for ${path}`).toBeTruthy();
    kebab!.click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  async function expectHighlightActionsVisible(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
    visible: boolean,
  ): Promise<void> {
    // Path Y overhaul: subtree-scope highlight items moved into the
    // Subtree > submenu, where their labels are simply "Highlight" /
    // "Remove highlight" (the submenu name carries the subtree
    // scope). The top-level menu still has single-row "Highlight" /
    // "Remove highlight". So we check both panels -- top-level for
    // single-row, and inside the Subtree submenu for the cascade
    // variants.
    const tree = getTree(fixture);
    const topPanel = document.body.querySelector<HTMLElement>('.mat-mdc-menu-panel');
    expect(topPanel).withContext('row menu panel open').toBeTruthy();
    const topLabels = Array.from(
      topPanel!.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
    )
      .map((menuItem) => (menuItem.textContent ?? '').trim())
      .filter((text) => text.length > 0);

    // Top-level: single-row Highlight + Remove highlight. Both
    // gate on canEditHighlights, so visibility=false -> both absent.
    expect(topLabels.includes(tree.ctxHighlightLabel))
      .withContext(`top-level Highlight visibility (visible=${visible})`)
      .toBe(visible);
    expect(topLabels.includes(tree.ctxRemoveHighlightLabel))
      .withContext(`top-level Remove highlight visibility (visible=${visible})`)
      .toBe(visible);

    if (visible) {
      // Open the Subtree submenu and check the cascade-scope items.
      const subtreeTrigger = Array.from(
        topPanel!.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
      ).find((menuItem) => (menuItem.textContent ?? '').trim().includes(tree.ctxSubtreeMenuLabel));
      expect(subtreeTrigger).withContext('Subtree submenu trigger present').toBeTruthy();
      subtreeTrigger!.dispatchEvent(
        new MouseEvent('mouseenter', { bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      const allPanels = Array.from(
        document.body.querySelectorAll<HTMLElement>('.mat-mdc-menu-panel'),
      );
      const subtreePanel = allPanels[allPanels.length - 1];
      expect(subtreePanel).withContext('Subtree submenu panel open').toBeTruthy();
      const subtreeLabels = Array.from(
        subtreePanel!.querySelectorAll<HTMLButtonElement>('button.mat-mdc-menu-item'),
      )
        .map((menuItem) => (menuItem.textContent ?? '').trim())
        .filter((text) => text.length > 0);
      expect(subtreeLabels.includes(tree.ctxHighlightTreeLabel))
        .withContext('subtree-scope Highlight (inside Subtree submenu) visibility')
        .toBeTrue();
      expect(subtreeLabels.includes(tree.ctxRemoveTreeHighlightLabel))
        .withContext('subtree-scope Remove highlight (inside Subtree submenu) visibility')
        .toBeTrue();
    }
    // visibility=false case: `canEditHighlights` is false in the
    // component, so all four highlight-related items are hidden by
    // their predicates regardless of which panel they live in.
    // Asserting their absence at the top level (above) is sufficient
    // -- the Subtree submenu trigger itself may still render due to
    // other reshape predicates, but its highlight-related contents
    // would also be hidden.
  }

  function highlightedReadOnlyBlob(ownerId: string): JsonBlob {
    return blob({
      content: '{"parent":{"child":{"leaf":1}}}',
      ownerId,
      isPublic: true,
      highlights: [
        { path: '$.parent', color: '#7e6500', cascade: true },
        { path: '$.parent.child', color: '#fff59d', cascade: false },
      ],
    });
  }

  it('passes canEditHighlights false and hides highlight menu actions for anonymous public viewers', async () => {
    const { fixture } = setup({ userId: null });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(highlightedReadOnlyBlob('owner-me'));

    await openTreeMenuForPath(fixture, '$.parent.child');

    const tree = getTree(fixture);
    expect(tree.canEditHighlights()).toBeFalse();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '.tree-row[data-path="$.parent.child"].has-manual-highlight',
      ),
    ).toBeTruthy();
    await expectHighlightActionsVisible(fixture, false);
  });

  it('passes canEditHighlights false and hides highlight menu actions for signed-in non-owners', async () => {
    const { fixture } = setup({ userId: 'viewer-me' });
    fixture.componentInstance.__loadBlobForTesting(highlightedReadOnlyBlob('owner-me'));

    await openTreeMenuForPath(fixture, '$.parent.child');

    expect(getTree(fixture).canEditHighlights()).toBeFalse();
    await expectHighlightActionsVisible(fixture, false);
  });

  it('passes canEditHighlights true and shows highlight menu actions for the owner', async () => {
    const { fixture } = setup({ userId: 'owner-me' });
    fixture.componentInstance.__loadBlobForTesting(highlightedReadOnlyBlob('owner-me'));

    await openTreeMenuForPath(fixture, '$.parent.child');

    expect(getTree(fixture).canEditHighlights()).toBeTrue();
    await expectHighlightActionsVisible(fixture, true);
  });

  it('passes canEditHighlights true for an unsaved buffer', async () => {
    const { fixture } = setup({ userId: null });
    const component = fixture.componentInstance;
    component.content.set('{"parent":{"child":{"leaf":1}}}');
    component.highlights.set([
      { path: '$.parent', color: '#7e6500', cascade: true },
      { path: '$.parent.child', color: '#fff59d', cascade: false },
    ]);

    await openTreeMenuForPath(fixture, '$.parent.child');

    expect(getTree(fixture).canEditHighlights()).toBeTrue();
    await expectHighlightActionsVisible(fixture, true);
  });

  it('save round-trips highlights and clears dirty from the server response', async () => {
    const serverHighlight: BlobHighlight = { path: '$.foo', color: '#00ff00', cascade: false };
    const updated = blob({ highlights: [serverHighlight], version: 2 });
    const { fixture, stub } = setup({ updateResult: updated });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ highlights: [] }));

    component.onHighlightsChange([highlightFoo]);
    expect(component.dirty()).toBeTrue();
    await component.onSave();

    expect(stub.update).toHaveBeenCalledWith('blob-1', {
      content: '{"foo":1,"bar":2}',
      title: 'Saved title',
      isPublic: false,
      highlights: [highlightFoo],
    });
    expect(component.highlights()).toEqual([serverHighlight]);
    expect(component.dirty()).toBeFalse();
  });

  it('prunes stale highlight paths when content parses successfully', async () => {
    const { fixture, stub } = setup({
      updateResult: blob({ content: '{"bar":2}', highlights: [] }),
    });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(
      blob({ content: '{"foo":1,"bar":2}', highlights: [highlightFoo] }),
    );
    component.content.set('{"bar":2}');

    await component.onSave();

    expect(stub.update.calls.mostRecent().args[1]).toEqual({
      content: '{"bar":2}',
      title: 'Saved title',
      isPublic: false,
      highlights: [],
    });
  });

  it('preserves highlights on save when content has a syntax error', async () => {
    const updated = blob({ content: '{"foo":', highlights: [highlightFoo] });
    const { fixture, stub } = setup({ updateResult: updated });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ content: '{"foo":1}', highlights: [highlightFoo] }));
    component.content.set('{"foo":');

    await component.onSave();

    expect(stub.update.calls.mostRecent().args[1]).toEqual({
      content: '{"foo":',
      title: 'Saved title',
      isPublic: false,
      highlights: [highlightFoo],
    });
  });

  it('prunes stale paths before PUT and adopts the echoed highlights', async () => {
    const highlightA: BlobHighlight = { path: '$.a', color: '#fff59d', cascade: false };
    const highlightBC: BlobHighlight = { path: '$.b.c', color: '#b3e5fc', cascade: false };
    const highlightD: BlobHighlight = { path: '$.d', color: '#c8e6c9', cascade: false };
    const survivingHighlights = [highlightA, highlightD];
    const { fixture, stub } = setup({
      updateResult: blob({ content: '{"a":1,"d":3}', highlights: survivingHighlights, version: 2 }),
    });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(
      blob({
        content: '{"a":1,"b":{"c":2},"d":3}',
        highlights: [highlightA, highlightBC, highlightD],
      }),
    );
    component.content.set('{"a":1,"d":3}');

    await component.onSave();

    expect(stub.update.calls.mostRecent().args[1]).toEqual({
      content: '{"a":1,"d":3}',
      title: 'Saved title',
      isPublic: false,
      highlights: survivingHighlights,
    });
    expect(component.highlights()).toEqual(survivingHighlights);
    expect(component.dirty()).toBeFalse();
  });

  it('skips pruning all highlights when saved content has a syntax error', async () => {
    const highlightA: BlobHighlight = { path: '$.a', color: '#fff59d', cascade: false };
    const highlightBC: BlobHighlight = { path: '$.b.c', color: '#b3e5fc', cascade: false };
    const highlightD: BlobHighlight = { path: '$.d', color: '#c8e6c9', cascade: false };
    const allHighlights = [highlightA, highlightBC, highlightD];
    const { fixture, stub } = setup({
      updateResult: blob({ content: '{"a":1,"d":', highlights: allHighlights, version: 2 }),
    });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(
      blob({ content: '{"a":1,"b":{"c":2},"d":3}', highlights: allHighlights }),
    );
    component.content.set('{"a":1,"d":');

    await component.onSave();

    expect(stub.update.calls.mostRecent().args[1]).toEqual({
      content: '{"a":1,"d":',
      title: 'Saved title',
      isPublic: false,
      highlights: allHighlights,
    });
    expect(component.highlights()).toEqual(allHighlights);
  });

  it('keeps dirty true when highlights change while save is in flight', async () => {
    const { fixture, stub } = setup();
    const component = fixture.componentInstance;
    const updateSubject = new Subject<JsonBlob>();
    stub.update.and.returnValue(updateSubject.asObservable());
    component.__loadBlobForTesting(blob({ highlights: [] }));
    component.onHighlightsChange([highlightFoo]);

    const savePromise = component.onSave();
    expect(component.saveInFlight()).toBeTrue();
    component.onHighlightsChange([highlightFoo, highlightBar]);
    updateSubject.next(blob({ highlights: [highlightFoo], version: 2 }));
    updateSubject.complete();
    await savePromise;

    expect(component.highlights()).toEqual([highlightFoo, highlightBar]);
    expect(component.dirty()).toBeTrue();
  });

  it('shows a conflict toast when a 412 refetch event arrives during save', async () => {
    const { fixture, stub, eventsSubject, snack } = setup();
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ highlights: [] }));
    component.onHighlightsChange([highlightFoo]);
    stub.update.and.callFake(() => {
      eventsSubject.next({
        kind: 'conflict',
        id: 'blob-1',
        blob: blob({ version: 2 }),
        status: 412,
      });
      return throwError(() => Object.assign(new Error('conflict'), { status: 412 }));
    });

    await component.onSave();

    expect(snack.open).toHaveBeenCalledWith(
      'Reloaded - this blob was changed in another tab',
      'Dismiss',
      { duration: 5000 },
    );
    expect(component.saveError()).toBeNull();
  });

  it('silently adopts remote coarse fields that were not edited locally', () => {
    const { fixture, eventsSubject, dialog } = setup();
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ content: '{"foo":1}' }));

    eventsSubject.next({
      kind: 'conflict',
      id: 'blob-1',
      blob: blob({ content: '{"foo":2}', version: 2 }),
      status: 412,
    });

    expect(component.content()).toBe('{"foo":2}');
    expect(component.dirty()).toBeFalse();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('prompts when local and remote coarse fields both changed', async () => {
    const { fixture, eventsSubject, dialog } = setup({ dialogResult: false });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ content: '{"foo":1}' }));
    component.content.set('{"foo":"local"}');

    eventsSubject.next({
      kind: 'conflict',
      id: 'blob-1',
      blob: blob({ content: '{"foo":"remote"}', version: 2 }),
      status: 412,
    });
    await waitForTaskQueue();

    expect(dialog.open).toHaveBeenCalled();
    expect(component.content()).toBe('{"foo":"remote"}');
  });

  it('merges disjoint local and remote highlight paths on conflict', () => {
    const { fixture, eventsSubject } = setup();
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ highlights: [] }));
    component.onHighlightsChange([highlightFoo]);

    eventsSubject.next({
      kind: 'conflict',
      id: 'blob-1',
      blob: blob({ highlights: [highlightBar], version: 2 }),
      status: 412,
    });

    expect(component.highlights()).toEqual([highlightBar, highlightFoo]);
    expect(component.dirty()).toBeTrue();
  });

  it('keeps the local highlight when local and remote edit the same path', () => {
    const { fixture, eventsSubject } = setup();
    const component = fixture.componentInstance;
    const remoteFoo: BlobHighlight = { path: '$.foo', color: '#00ff00', cascade: true };
    component.__loadBlobForTesting(blob({ highlights: [] }));
    component.onHighlightsChange([highlightFoo]);

    eventsSubject.next({
      kind: 'conflict',
      id: 'blob-1',
      blob: blob({ highlights: [remoteFoo], version: 2 }),
      status: 412,
    });

    expect(component.highlights()).toEqual([highlightFoo]);
    expect(component.dirty()).toBeTrue();
  });

  it('keeps a local highlight delete over a remote recolor on the same path', () => {
    const { fixture, eventsSubject } = setup();
    const component = fixture.componentInstance;
    const remoteFoo: BlobHighlight = { path: '$.foo', color: '#00ff00', cascade: true };
    component.__loadBlobForTesting(blob({ highlights: [highlightFoo] }));
    component.onHighlightsChange([]);

    eventsSubject.next({
      kind: 'conflict',
      id: 'blob-1',
      blob: blob({ highlights: [remoteFoo], version: 2 }),
      status: 412,
    });

    expect(component.highlights()).toEqual([]);
    expect(component.dirty()).toBeTrue();
  });

  it('passes highlights into the tree and consumes highlight changes from the tree', () => {
    const { fixture } = setup({ userId: 'owner-me' });
    const component = fixture.componentInstance;
    component.__loadBlobForTesting(blob({ highlights: [highlightFoo], ownerId: 'owner-me' }));
    fixture.detectChanges();

    const tree = fixture.debugElement.query(By.directive(JsonTreeComponent))
      .componentInstance as JsonTreeComponent;
    expect(tree.highlights()).toEqual([highlightFoo]);
    expect(tree.canEditHighlights()).toBeTrue();

    tree.highlightsChange.emit([highlightBar]);

    expect(component.highlights()).toEqual([highlightBar]);
  });

  it('passes canEditHighlights false when the signed-in user is not the owner', () => {
    const { fixture } = setup({ userId: 'viewer-me' });
    fixture.componentInstance.__loadBlobForTesting(blob({ ownerId: 'owner-me' }));
    fixture.detectChanges();

    const tree = fixture.debugElement.query(By.directive(JsonTreeComponent))
      .componentInstance as JsonTreeComponent;
    expect(tree.canEditHighlights()).toBeFalse();
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
    fixture.componentInstance.__loadBlobForTesting({
      id: 'b1',
      slug: 's1',
      content: '{}',
      title: 'My Config',
      ownerId: 'o1',
      isPublic: false,
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(spy).toHaveBeenCalledWith('My Config | JotJSON');
  });

  it('falls back to "Untitled" when a blob has no title', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const titleSvc = TestBed.inject(Title);
    const spy = spyOn(titleSvc, 'setTitle');
    fixture.componentInstance.__loadBlobForTesting({
      id: 'b1',
      slug: 's1',
      content: '{}',
      ownerId: 'o1',
      isPublic: false,
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });
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
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => clearHomeStorage());

  function flushComponentEffects(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
  ): void {
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
      title: 'Saved title',
    });

    fixture.componentInstance.__loadBlobForTesting(jsonBlob);
    fixture.componentInstance.content.set('{"saved":false}');
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');
  });

  it('removes the star prefix when dirty content is reverted', () => {
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);
    const jsonBlob = makeIdentityBlob({
      content: '{"saved":true}',
      title: 'Saved title',
    });

    fixture.componentInstance.__loadBlobForTesting(jsonBlob);
    fixture.componentInstance.content.set('{"saved":false}');
    flushComponentEffects(fixture);
    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');

    fixture.componentInstance.content.set(jsonBlob.content);
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toBe('Saved title | JotJSON');
  });

  it('adds a star prefix to the dirty draft fallback title', () => {
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);

    fixture.componentInstance.content.set('{"draft":true}');
    fixture.componentInstance.title.set('Draft title');
    flushComponentEffects(fixture);

    expect(mostRecentTitle(titleSpy)).toContain(
      'JotJSON - JSON viewer, formatter, and tree explorer',
    );
    expect(mostRecentTitle(titleSpy).startsWith('* ')).toBeTrue();
  });

  it('removes the star prefix after a successful save resets dirty state', async () => {
    const originalBlob = makeIdentityBlob({
      content: '{"saved":true}',
      title: 'Saved title',
      ownerId: 'owner-me',
    });
    const updatedBlob = makeIdentityBlob({
      content: '{"saved":false}',
      title: 'Saved title',
      ownerId: 'owner-me',
    });
    const blobService = {
      create: jasmine.createSpy('create').and.returnValue(of(updatedBlob)),
      update: jasmine.createSpy('update').and.returnValue(of(updatedBlob)),
      get: jasmine.createSpy('get').and.returnValue(of(originalBlob)),
      events$: EMPTY,
    };
    TestBed.overrideProvider(BlobService, { useValue: blobService });
    signInFakeUser(TestBed.inject(AuthService), {
      user: { id: 'owner-me', displayName: 'Owner User' },
    });
    const titleService = TestBed.inject(Title);
    const titleSpy = spyOn(titleService, 'setTitle');
    const fixture = TestBed.createComponent(HomeComponent);

    fixture.componentInstance.__loadBlobForTesting(originalBlob);
    fixture.componentInstance.content.set(updatedBlob.content);
    fixture.componentInstance.title.set('Saved title');
    flushComponentEffects(fixture);
    expect(mostRecentTitle(titleSpy)).toBe('* Saved title | JotJSON');

    await fixture.componentInstance.onSave();
    flushComponentEffects(fixture);

    expect(blobService.update).toHaveBeenCalledWith('identity-blob-1', {
      content: '{"saved":false}',
      title: 'Saved title',
      isPublic: false,
      highlights: [],
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
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
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
      update: jasmine
        .createSpy('update')
        .and.callFake(() =>
          opts.updateResult instanceof Error
            ? throwError(() => opts.updateResult as Error)
            : of(opts.updateResult ?? blob()),
        ),
      delete: jasmine
        .createSpy('delete')
        .and.callFake(() =>
          opts.deleteResult instanceof Error
            ? throwError(() => opts.deleteResult as Error)
            : of(undefined),
        ),
      get: jasmine.createSpy('get').and.returnValue(of(blob())),
      events$: EMPTY,
    };

    const fakeAuth: Partial<AuthService> = {
      user: (() => ({ id: opts.userId, displayName: 'Test' })) as AuthService['user'],
      isSignedIn: (() => true) as AuthService['isSignedIn'],
      isConfigured: true,
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
        get: () => undefined as unknown as Clipboard,
      });
    } else {
      clipboardStub = {
        writeText: jasmine
          .createSpy('writeText')
          .and.returnValue(
            opts.clipboardFails ? Promise.reject(new Error('x')) : Promise.resolve(),
          ),
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => clipboardStub as unknown as Clipboard,
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
        { provide: MatSnackBar, useValue: snack },
      ],
    });

    const fixture = TestBed.createComponent(HomeComponent);
    if (opts.loaded) fixture.componentInstance.__loadBlobForTesting(opts.loaded);
    return { fixture, stub, dialog, snack, clipboardStub };
  }

  it('onCopyShareLink writes /s/<slug> URL to the clipboard and toasts on success', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
    });
    fixture.componentInstance.onCopyShareLink();
    // Let the clipboard promise flush.
    await Promise.resolve();
    await Promise.resolve();
    const writeText = (navigator.clipboard as unknown as { writeText: jasmine.Spy }).writeText;
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/s/abc123`);
    expect(snack.open).toHaveBeenCalled();
  });

  it('onCopyShareLink toasts an error when the browser lacks clipboard API', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      clipboardAvailable: false,
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
      updateResult: updated,
    });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    await fixture.componentInstance.onTogglePublic();
    expect(stub.update).toHaveBeenCalledWith('blob-1', { isPublic: true });
    expect(fixture.componentInstance.loadedBlob()?.isPublic).toBe(true);
    expect(snack.open).toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.visibility.changed',
      { newVisibility: 'public' },
      undefined,
    );
  });

  it('onTogglePublic emits private visibility telemetry after a public-to-private update', async () => {
    const updated = blob({ isPublic: false });
    const { fixture, stub, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ isPublic: true }),
      updateResult: updated,
    });
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    await fixture.componentInstance.onTogglePublic();
    expect(stub.update).toHaveBeenCalledWith('blob-1', { isPublic: false });
    expect(fixture.componentInstance.loadedBlob()?.isPublic).toBe(false);
    expect(snack.open).toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledOnceWith(
      'share.visibility.changed',
      { newVisibility: 'private' },
      undefined,
    );
  });

  it('onTogglePublic toasts an error without visibility telemetry when the update fails', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      updateResult: new Error('nope'),
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
      loaded: blob(),
    });
    await fixture.componentInstance.onTogglePublic();
    expect(stub.update).not.toHaveBeenCalled();
  });

  it('onDeleteBlob confirms, deletes, clears state, and navigates home', async () => {
    const { fixture, stub, dialog, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ title: 'My Config' }),
      confirm: true,
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
      confirm: false,
    });
    await fixture.componentInstance.onDeleteBlob();
    expect(stub.delete).not.toHaveBeenCalled();
    expect(fixture.componentInstance.loadedBlob()).not.toBeNull();
  });

  it('onDeleteBlob focuses the home main fallback after confirming delete', async () => {
    const { fixture } = setup({
      userId: 'owner-me',
      loaded: blob(),
      confirm: true,
    });
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    const teardown = attachToBody(fixture);
    try {
      fixture.detectChanges();
      await fixture.componentInstance.onDeleteBlob();
      fixture.detectChanges();
      await waitForTaskQueue();

      const main = fixture.nativeElement.querySelector('main.home-main') as HTMLElement;
      expect(document.activeElement).toBe(main);
    } finally {
      teardown();
    }
  });

  it('onDeleteBlob toasts an error when delete fails and preserves local state', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      confirm: true,
      deleteResult: new Error('boom'),
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
        { provide: MatSnackBar, useValue: snack },
      ],
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
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as File;
  }

  function makeRejectingFile(): File {
    return {
      size: 100,
      name: 'rejecting.json',
      text: () => Promise.reject(new Error('boom')),
      arrayBuffer: () => Promise.reject(new Error('boom')),
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
      sizeBytes: MAX_UPLOAD_BYTES + 1,
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
        firstPaintMs: jasmine.any(Number),
      }),
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
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(text).buffer),
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
        firstPaintMs: jasmine.any(Number),
      }),
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
      sizeBytes: MAX_UPLOAD_BYTES + 1,
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
      (debugEl) => debugEl.componentInstance instanceof DropOverlayComponent,
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
      providers: [...provideFakeAuth(), provideRouter([])],
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
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('INFO log {"a":1}'));
    const extractor = TestBed.inject(JsonExtractorService);
    spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 1,
      preservesComments: true,
      hasComments: false,
    });

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(component.extractBannerVisible()).toBe(true);
    expect(component.extractedCandidate()?.data.blockCount).toBe(1);
  });

  it('toolbar paste with already-valid JSON does NOT show the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('{"a":1}'));
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
      preservesComments: true,
      hasComments: false,
    });

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'prefix INFO log {"a":1}',
      postPasteParses: false,
    });

    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledWith('INFO log {"a":1}');
    expect(component.extractBannerVisible()).toBe(true);
  });

  it('native paste with full-buffer-parses skips extractor and clears prior candidate', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: { text: 'stale', blockCount: 1, preservesComments: true, hasComments: false },
      sourceVersion: 999,
      source: 'paste',
    });
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.callThrough();

    component.onEditorPaste({
      pastedText: '{"a":1}',
      postPasteContent: '{"a":1}',
      postPasteParses: true,
    });

    expect(extractSpy).not.toHaveBeenCalled();
    expect(component.extractedCandidate()).toBeNull();
    expect(component.extractBannerVisible()).toBe(false);
  });

  it('onExtractAccept replaces content and clears the banner', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: { text: '{ "a": 1 }', blockCount: 1, preservesComments: true, hasComments: false },
      sourceVersion: 0,
      source: 'paste',
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
      data: { text: '{ "a": 1 }', blockCount: 1, preservesComments: true, hasComments: false },
      sourceVersion: 999,
      source: 'paste',
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
      preservesComments: true,
      hasComments: false,
    });

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
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
      preservesComments: true,
      hasComments: false,
    });
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    expect(extractor.extractFromMixedText).toHaveBeenCalledWith('INFO log {"a":1}');
    expect(component.extractBannerVisible()).toBe(true);
    expect(component.extractedCandidate()?.data.blockCount).toBe(1);
  });

  it('file load with already-valid JSON does NOT show the extract banner', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    const extractSpy = spyOn(extractor, 'extractFromMixedText').and.callThrough();
    const file = new File(['{"a":1}'], 'data.json', {
      type: 'application/json',
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    expect(extractSpy).not.toHaveBeenCalled();
    expect(component.extractBannerVisible()).toBe(false);
    expect(component.extractedCandidate()).toBeNull();
  });

  // M7u: prose-preserving paste extraction (formerly only on tree path).
  // The extractor service runs unmocked so these tests cover the full
  // pipeline end-to-end.

  it('M7u: editor paste of one block with no surrounding prose extracts to the bare value', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;

    component.onEditorPaste({
      pastedText: '{"a":1}',
      postPasteContent: '{"a":1}',
      postPasteParses: false,
    });

    const candidate = component.extractedCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate?.data.blockCount).toBe(1);
    expect(candidate?.data.proseSegments ?? 0).toBe(0);
    const parsed = JSON.parse(candidate!.data.text) as unknown;
    expect(parsed).toEqual({ a: 1 });
  });

  it('M7u: editor paste of one block with surrounding prose extracts to a wrapper', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;

    component.onEditorPaste({
      pastedText: 'INFO: log line {"a":1} trailing words',
      postPasteContent: 'INFO: log line {"a":1} trailing words',
      postPasteParses: false,
    });

    const candidate = component.extractedCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate?.data.blockCount).toBe(1);
    expect(candidate?.data.proseSegments ?? 0).toBe(2);
    const parsed = JSON.parse(candidate!.data.text) as Record<string, unknown>;
    expect(parsed['prefix']).toBe('INFO: log line ');
    expect(parsed['json']).toEqual({ a: 1 });
    expect(parsed['suffix']).toBe(' trailing words');
  });

  it('M7u: editor paste of multiple blocks with no prose extracts to the bare array', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;

    component.onEditorPaste({
      pastedText: '{"a":1}{"b":2}',
      postPasteContent: '{"a":1}{"b":2}',
      postPasteParses: false,
    });

    const candidate = component.extractedCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate?.data.blockCount).toBe(2);
    expect(candidate?.data.proseSegments ?? 0).toBe(0);
    const parsed = JSON.parse(candidate!.data.text) as unknown;
    expect(parsed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('M7u: editor paste of multiple blocks with prose extracts to a prose-preserving wrapper (real-world HTTP transcript)', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;

    // The user-reported real-world sample: HTTP request details with two
    // JSON payloads (x-ms-test header and request body) wrapped in
    // request-line, header, and operation-name prose.
    const pasted =
      'Dependent service request details: POST /v1.0/events api-version: 2019-09-30 ' +
      'x-ms-test: {"scenarios":"PurchaseRunner,skip-provisioning,auto-patch:completed",' +
      '"contact":"compur","retention":"2026-05-08T22:12:21.6474607Z"} ' +
      'x-ms-correlation-id: ea49bede-d5da-4998-9f6a-f86dc20c5174 MS-CV: XqqPdwxcOUqvxyi3.1.2 ' +
      'Content-Type: application/json ' +
      '{"eventId":"5366e945-262e-42dc-8cdf-8969adcdea65_2019-05-31","fetchPayload":true,' +
      '"queryParameters":{"eventType":"BusinessLocationSummary",' +
      '"eventSource":"account-organization-2019-05-31","version":1,' +
      '"accountId":"257c0731-7897-5830-7c4e-708dae0a712b",' +
      '"organizationId":"5366e945-262e-42dc-8cdf-8969adcdea65_2019-05-31",' +
      '"businessLocationId":"eea4cdb9-166e-5e35-3afb-502f12a5aea5"},"continuationToken":null}. ' +
      'OperationName: RequestDetails_Collector_SearchEvents_BusinessLocationSummary.';

    component.onEditorPaste({
      pastedText: pasted,
      postPasteContent: pasted,
      postPasteParses: false,
    });

    const candidate = component.extractedCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate?.data.blockCount).toBe(2);
    expect((candidate?.data.proseSegments ?? 0) >= 1).toBeTrue();

    const parsed = JSON.parse(candidate!.data.text) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toContain('json1');
    expect(keys).toContain('json2');
    expect(keys).toContain('prefix');
    expect(keys).toContain('suffix');
    expect(keys.some((k) => k.startsWith('between_'))).toBeTrue();

    expect(parsed['prefix'] as string).toContain('Dependent service request details');
    expect(parsed['json1']).toEqual({
      scenarios: 'PurchaseRunner,skip-provisioning,auto-patch:completed',
      contact: 'compur',
      retention: '2026-05-08T22:12:21.6474607Z',
    });
    const body = parsed['json2'] as Record<string, unknown>;
    expect(body['eventId']).toBe('5366e945-262e-42dc-8cdf-8969adcdea65_2019-05-31');
    expect(body['fetchPayload']).toBe(true);
    expect(parsed['suffix'] as string).toContain(
      'OperationName: RequestDetails_Collector_SearchEvents_BusinessLocationSummary.',
    );
  });

  it('M7u: leading BOM with prose is preserved in the prefix', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;

    component.onEditorPaste({
      pastedText: '\uFEFFhello {"a":1}',
      postPasteContent: '\uFEFFhello {"a":1}',
      postPasteParses: false,
    });

    const candidate = component.extractedCandidate();
    expect(candidate).not.toBeNull();
    expect(candidate?.data.proseSegments).toBe(1);
    const parsed = JSON.parse(candidate!.data.text) as Record<string, unknown>;
    expect(parsed['prefix']).toBe('\uFEFFhello ');
    expect(parsed['json']).toEqual({ a: 1 });
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
        { provide: DocumentDropController, useValue: drop },
      ],
    });
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    const extractor = TestBed.inject(JsonExtractorService);
    const extractorSpy = spyOn(extractor, 'extractFromMixedText').and.returnValue({
      text: '{ "a": 1 }',
      blockCount: 2,
      preservesComments: false,
      hasComments: false,
    });
    fixture.detectChanges();
    const eventSpy = spyOn(TestBed.inject(LoggerService), 'event');
    return { fixture, component, eventSpy, extractorSpy, drop };
  }

  function bannerCalls(spy: jasmine.Spy): unknown[][] {
    return spy.calls
      .allArgs()
      .filter(
        (args) =>
          typeof args[0] === 'string' && (args[0] as string).startsWith('home.extract.banner.'),
      );
  }

  afterEach(() => {
    clearHomeStorage();
  });

  it('toolbar paste fires shown with source="paste"', async () => {
    const { component, eventSpy } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('INFO log {"a":1}'));

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(eventSpy).toHaveBeenCalledWith(
      'home.extract.banner.shown',
      { source: 'paste' },
      { blockCount: 2, preservesComments: 0, hasComments: 0, proseSegments: 0 },
    );
  });

  it('native editor paste fires shown with source="editor.paste"', () => {
    const { component, eventSpy } = setupTelemetryBed();

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
    });

    expect(eventSpy).toHaveBeenCalledWith(
      'home.extract.banner.shown',
      { source: 'editor.paste' },
      { blockCount: 2, preservesComments: 0, hasComments: 0, proseSegments: 0 },
    );
  });

  it('Upload pick fires shown with source="upload.pick"', async () => {
    const { component, eventSpy } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();

    const shownCalls = bannerCalls(eventSpy).filter(
      (args) => args[0] === 'home.extract.banner.shown',
    );
    expect(shownCalls.length).toBe(1);
    expect(shownCalls[0]).toEqual([
      'home.extract.banner.shown',
      { source: 'upload.pick' },
      { blockCount: 2, preservesComments: 0, hasComments: 0, proseSegments: 0 },
    ]);
  });

  it('drag-drop fires shown with source="upload.drag"', async () => {
    const { eventSpy, drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });
    expect(drop.registeredHandler).toBeDefined();

    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();

    const shownCalls = bannerCalls(eventSpy).filter(
      (args) => args[0] === 'home.extract.banner.shown',
    );
    expect(shownCalls.length).toBe(1);
    expect(shownCalls[0]).toEqual([
      'home.extract.banner.shown',
      { source: 'upload.drag' },
      { blockCount: 2, preservesComments: 0, hasComments: 0, proseSegments: 0 },
    ]);
  });

  it('onExtractAccept fires accept and does NOT fire dismiss(content.changed)', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
    });
    eventSpy.calls.reset();

    component.onExtractAccept();

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('home.extract.banner.accept');
    expect(calls[0][1]).toEqual({ source: 'editor.paste' });
    expect(calls[0][2]).toEqual({
      blockCount: 2,
      preservesComments: 0,
      hasComments: 0,
      proseSegments: 0,
    });
  });

  it('shown event reports hasComments:1 when source had JSONC comments', () => {
    const { component, eventSpy, extractorSpy } = setupTelemetryBed();
    extractorSpy.and.returnValue({
      text: '[{"a":1},{"b":2}]',
      blockCount: 2,
      preservesComments: false,
      hasComments: true,
    });

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1} {/*c*/"b":2}',
      postPasteContent: 'INFO log {"a":1} {/*c*/"b":2}',
      postPasteParses: false,
    });

    expect(eventSpy).toHaveBeenCalledWith(
      'home.extract.banner.shown',
      { source: 'editor.paste' },
      { blockCount: 2, preservesComments: 0, hasComments: 1, proseSegments: 0 },
    );
  });

  it('accept event mirrors hasComments:1 from the captured candidate', () => {
    const { component, eventSpy, extractorSpy } = setupTelemetryBed();
    extractorSpy.and.returnValue({
      text: '[{"a":1},{"b":2}]',
      blockCount: 2,
      preservesComments: false,
      hasComments: true,
    });
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1} {/*c*/"b":2}',
      postPasteContent: 'INFO log {"a":1} {/*c*/"b":2}',
      postPasteParses: false,
    });
    eventSpy.calls.reset();

    component.onExtractAccept();

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      'home.extract.banner.accept',
      { source: 'editor.paste' },
      { blockCount: 2, preservesComments: 0, hasComments: 1, proseSegments: 0 },
    ]);
  });

  it('onExtractDismiss fires dismiss with reason="user.click"', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
    });
    eventSpy.calls.reset();

    component.onExtractDismiss();

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      'home.extract.banner.dismiss',
      { source: 'editor.paste', reason: 'user.click' },
      { blockCount: 2, proseSegments: 0 },
    ]);
  });

  it('typing while the banner is visible fires dismiss with reason="content.changed"', () => {
    const { component, eventSpy } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
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
      { blockCount: 2, proseSegments: 0 },
    ]);
  });

  it('a second paste replacing a visible banner fires dismiss(old) + shown(new)', async () => {
    const { component, eventSpy, extractorSpy } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('INFO log {"a":1}'));
    await component.onPaste();
    await waitForDoubleAnimationFrame();
    expect(component.extractBannerVisible()).toBe(true);
    eventSpy.calls.reset();
    extractorSpy.and.returnValue({
      text: '{ "b": 2 }',
      blockCount: 1,
      preservesComments: true,
      hasComments: false,
    });

    component.onEditorPaste({
      pastedText: 'log {"b":2}',
      postPasteContent: 'log {"b":2}',
      postPasteParses: false,
    });

    const calls = bannerCalls(eventSpy);
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      'home.extract.banner.dismiss',
      { source: 'paste', reason: 'content.changed' },
      { blockCount: 2, proseSegments: 0 },
    ]);
    expect(calls[1]).toEqual([
      'home.extract.banner.shown',
      { source: 'editor.paste' },
      { blockCount: 1, preservesComments: 1, hasComments: 0, proseSegments: 0 },
    ]);
  });

  it('candidate carries source="paste" only on toolbar Paste path', async () => {
    const { component } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('INFO log {"a":1}'));

    await component.onPaste();
    await waitForDoubleAnimationFrame();

    expect(component.extractedCandidate()?.source).toBe('paste');
  });

  it('candidate carries source="editor.paste" on native editor paste', () => {
    const { component } = setupTelemetryBed();
    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
    });
    expect(component.extractedCandidate()?.source).toBe('editor.paste');
  });

  it('candidate carries source="upload.pick" on Upload-button path', async () => {
    const { component } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });
    await component.onUpload(file);
    await waitForDoubleAnimationFrame();
    expect(component.extractedCandidate()?.source).toBe('upload.pick');
  });

  it('candidate carries source="upload.drag" on drag-drop path', async () => {
    const { component, drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });
    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();
    expect(component.extractedCandidate()?.source).toBe('upload.drag');
  });

  it('toolbar paste auto-focuses the banner Extract button', async () => {
    const focusSpy = spyOn(ExtractJsonBannerComponent.prototype, 'focusExtractButton');
    const { component } = setupTelemetryBed();
    spyOn(navigator.clipboard, 'readText').and.returnValue(Promise.resolve('INFO log {"a":1}'));

    await component.onPaste();
    await waitForDoubleAnimationFrame();
    await waitForTaskQueue();

    expect(focusSpy).toHaveBeenCalled();
  });

  it('native editor paste does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(ExtractJsonBannerComponent.prototype, 'focusExtractButton');
    const { component } = setupTelemetryBed();

    component.onEditorPaste({
      pastedText: 'INFO log {"a":1}',
      postPasteContent: 'INFO log {"a":1}',
      postPasteParses: false,
    });
    await waitForTaskQueue();

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('Upload pick does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(ExtractJsonBannerComponent.prototype, 'focusExtractButton');
    const { component } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });

    await component.onUpload(file);
    await waitForDoubleAnimationFrame();
    await waitForTaskQueue();

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('drag-drop does NOT auto-focus the banner Extract button', async () => {
    const focusSpy = spyOn(ExtractJsonBannerComponent.prototype, 'focusExtractButton');
    const { drop } = setupTelemetryBed();
    const file = new File(['INFO log {"a":1}'], 'capture.log', {
      type: 'text/plain',
    });

    drop.registeredHandler!([file]);
    await waitForTaskQueue();
    await waitForTaskQueue();
    await waitForDoubleAnimationFrame();

    expect(focusSpy).not.toHaveBeenCalled();
  });
});

describe('HomeComponent extract-banner commentsWillBeDropped binding', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
  });

  function readBannerCommentsWillBeDropped(
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>,
  ): boolean | null {
    const debugEl = fixture.debugElement.query(By.directive(ExtractJsonBannerComponent));
    if (!debugEl) {
      return null;
    }
    const banner = debugEl.componentInstance as ExtractJsonBannerComponent;
    return banner.commentsWillBeDropped();
  }

  it('multi-block + hasComments:true makes the banner show "comments will be dropped"', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: {
        text: '[{"a":1},{"b":2}]',
        blockCount: 2,
        preservesComments: false,
        hasComments: true,
      },
      sourceVersion: 0,
      source: 'paste',
    });
    fixture.detectChanges();

    expect(readBannerCommentsWillBeDropped(fixture)).toBe(true);
  });

  it('multi-block + hasComments:false suppresses the comment-status line', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: {
        text: '[{"a":1},{"b":2}]',
        blockCount: 2,
        preservesComments: false,
        hasComments: false,
      },
      sourceVersion: 0,
      source: 'paste',
    });
    fixture.detectChanges();

    expect(readBannerCommentsWillBeDropped(fixture)).toBe(false);
  });

  it('single-block + hasComments:true suppresses the comment-status line (single-block preserves comments)', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: {
        text: '{ /* note */ "a": 1 }',
        blockCount: 1,
        preservesComments: true,
        hasComments: true,
      },
      sourceVersion: 0,
      source: 'paste',
    });
    fixture.detectChanges();

    expect(readBannerCommentsWillBeDropped(fixture)).toBe(false);
  });

  it('single-block + hasComments:false suppresses the comment-status line', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const component = fixture.componentInstance;
    component.extractedCandidate.set({
      data: {
        text: '{ "a": 1 }',
        blockCount: 1,
        preservesComments: true,
        hasComments: false,
      },
      sourceVersion: 0,
      source: 'paste',
    });
    fixture.detectChanges();

    expect(readBannerCommentsWillBeDropped(fixture)).toBe(false);
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
        { provide: MatSnackBar, useValue: snack },
      ],
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
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"a":').buffer),
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
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"a":1}').buffer),
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
        { provide: MatSnackBar, useValue: snack },
      ],
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
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
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
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const fakePng = {
      size: pngBytes.byteLength,
      name: 'dropped.png',
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(pngBytes.buffer),
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

describe('HomeComponent M7p title-suggester wiring', () => {
  setupMinimalMonacoStub();
  beforeEach(() => {
    clearHomeStorage();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [...provideFakeAuth(), provideRouter([])],
    });
  });

  afterEach(async () => {
    await waitForDoubleAnimationFrame();
  });

  it('lastFilename and suggestedTitlesForMenu start empty', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    expect(fixture.componentInstance.lastFilename()).toBeNull();
    expect(fixture.componentInstance.suggestedTitlesForMenu()).toEqual([]);
  });

  it('wandEnabled is true when title is set as long as content is non-empty', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentInstance.title.set('My Title');
    expect(fixture.componentInstance.wandEnabled()).toBe(true);
  });

  it('wandEnabled is false when content is empty', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('   ');
    fixture.componentInstance.title.set('');
    expect(fixture.componentInstance.wandEnabled()).toBe(false);
  });

  it('wandEnabled is false when content is empty even if title is set', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    fixture.componentInstance.title.set('My Title');
    expect(fixture.componentInstance.wandEnabled()).toBe(false);
  });

  it('wandEnabled is true when title is empty AND content is non-empty', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentInstance.title.set('');
    expect(fixture.componentInstance.wandEnabled()).toBe(true);
  });

  it('onSuggestRequested populates suggestedTitlesForMenu using current content', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"name":"alice"}');
    fixture.componentInstance.lastFilename.set('users-export.json');
    fixture.componentInstance.onSuggestRequested();
    const candidates = fixture.componentInstance.suggestedTitlesForMenu();
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // Filename and namedField produce different values ("users-export"
    // vs "alice"), so neither dedupes the other away.
    expect(candidates.some((c) => c.source === 'filename')).toBe(true);
    expect(candidates.some((c) => c.source === 'namedField')).toBe(true);
  });

  it('onClear clears lastFilename and suggestedTitlesForMenu', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.lastFilename.set('something.json');
    fixture.componentInstance.suggestedTitlesForMenu.set([
      { value: 'A', source: 'filename', confidence: 95 },
    ]);
    fixture.componentInstance.onClear();
    expect(fixture.componentInstance.lastFilename()).toBeNull();
    expect(fixture.componentInstance.suggestedTitlesForMenu()).toEqual([]);
  });

  it('onPaste clears any existing lastFilename', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.lastFilename.set('prior.json');
    spyOn(TestBed.inject(ClipboardPollingService), 'readForPaste').and.resolveTo('{"pasted":true}');
    await fixture.componentInstance.onPaste();
    expect(fixture.componentInstance.lastFilename()).toBeNull();
    expect(fixture.componentInstance.suggestedTitlesForMenu()).toEqual([]);
  });

  it('onSuggestRequested with empty content returns []', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('');
    fixture.componentInstance.onSuggestRequested();
    expect(fixture.componentInstance.suggestedTitlesForMenu()).toEqual([]);
  });

  it('onUpload of a JSON file sets lastFilename to the file name', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const file = new File(['{"x":1}'], 'config.json', { type: 'application/json' });
    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.lastFilename()).toBe('config.json');
  });

  it('onFormat preserves lastFilename', async () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const file = new File(['{"x":1}'], 'config.json', { type: 'application/json' });
    await fixture.componentInstance.onUpload(file);
    expect(fixture.componentInstance.lastFilename()).toBe('config.json');
    fixture.componentInstance.onFormat();
    expect(fixture.componentInstance.lastFilename()).toBe('config.json');
  });
});

describe('HomeComponent tree extract wiring (M7s)', () => {
  setupMinimalMonacoStub();

  let realWorldFixtureText = '';

  beforeAll(async () => {
    const response = await fetch('/fixtures/JsonExtraction.json');
    if (!response.ok) {
      throw new Error(
        `Failed to load fixtures/JsonExtraction.json: HTTP ${response.status}. ` +
          `Ensure src/testing/fixtures is registered in angular.json test assets.`,
      );
    }
    realWorldFixtureText = await response.text();
  });

  class FakeTreeStringExtractor {
    readonly candidatesSignal = signal<ReadonlyMap<string, ExtractedJson>>(
      new Map<string, ExtractedJson>(),
    );
    readonly scannerUnavailableSignal = signal(false);
    readonly scanInFlightSignal = signal(false);
    readonly currentVersionSignal = signal(0);
    readonly candidates = this.candidatesSignal.asReadonly();
    readonly scannerUnavailable = this.scannerUnavailableSignal.asReadonly();
    readonly scanInFlight = this.scanInFlightSignal.asReadonly();
    readonly currentVersion = this.currentVersionSignal.asReadonly();
    readonly beginGeneration = jasmine.createSpy('beginGeneration').and.callFake((): number => {
      const sourceVersion = this.currentVersionSignal() + 1;
      this.currentVersionSignal.set(sourceVersion);
      this.candidatesSignal.set(new Map<string, ExtractedJson>());
      this.scanInFlightSignal.set(false);
      return sourceVersion;
    });
    readonly enqueueScan = jasmine.createSpy('enqueueScan');

    setVersion(sourceVersion: number): void {
      this.currentVersionSignal.set(sourceVersion);
    }

    setCandidates(candidates: ReadonlyMap<string, ExtractedJson>): void {
      this.candidatesSignal.set(candidates);
    }
  }

  function extracted(text: string, blockCount = 1, proseSegments = 0): ExtractedJson {
    return {
      text,
      blockCount,
      preservesComments: true,
      proseSegments,
      hasComments: text.includes('//') || text.includes('/*'),
    };
  }

  function extractRequest(
    replacement: ExtractedJson,
    overrides: Partial<TreeExtractRequest> = {},
  ): TreeExtractRequest {
    return {
      path: ['payload'],
      sourceVersion: 1,
      replacement,
      source: 'rowPillPrimitiveArray',
      ...overrides,
    };
  }

  const parseJsonCandidate: ParseJsonCandidate = (candidateText: string) => {
    const errors: ParseError[] = [];
    const value: unknown = parse(candidateText, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    return { value, errors };
  };

  function parseJsoncForTreeExtract(text: string): unknown {
    const errors: ParseError[] = [];
    const value: unknown = parse(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    expect(errors).toEqual([]);
    return value;
  }

  function requireRecord(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Expected ${context} to be an object`);
    }
    return value as Record<string, unknown>;
  }

  function readFirstParameterValue(text: string): unknown {
    const root = requireRecord(parseJsoncForTreeExtract(text), 'fixture root');
    const parameters = root['Parameters'];
    if (!Array.isArray(parameters)) {
      throw new Error('Expected fixture Parameters to be an array');
    }
    const firstParameter = parameters[0];
    const parameterRecord = requireRecord(firstParameter, 'first parameter');
    return parameterRecord['Value'];
  }

  interface ExtractSnackBarStub {
    open: jasmine.Spy<
      (message: string, action?: string, config?: unknown) => MatSnackBarRef<TextOnlySnackBar>
    >;
  }

  interface ExtractSnackBarRefHarness {
    action: Subject<void>;
    dismissSpy: jasmine.Spy;
    ref: MatSnackBarRef<TextOnlySnackBar>;
  }

  interface ExtractEditorStub {
    applyEdit: jasmine.Spy<
      (startOffset: number, endOffset: number, text: string, source: string) => boolean
    >;
  }

  function createExtractSnackBarRefHarness(): ExtractSnackBarRefHarness {
    const action = new Subject<void>();
    const dismissed = new Subject<unknown>();
    const dismissSpy = jasmine.createSpy('dismiss');
    const snackRef: Partial<MatSnackBarRef<TextOnlySnackBar>> = {
      onAction: () => action.asObservable(),
      afterDismissed: () =>
        dismissed.asObservable() as unknown as ReturnType<
          MatSnackBarRef<TextOnlySnackBar>['afterDismissed']
        >,
      dismiss: dismissSpy,
    };
    return {
      action,
      dismissSpy,
      ref: snackRef as unknown as MatSnackBarRef<TextOnlySnackBar>,
    };
  }

  function createExtractEditorStub(component: HomeComponent): ExtractEditorStub {
    return {
      applyEdit: jasmine
        .createSpy('applyEdit')
        .and.callFake(
          (startOffset: number, endOffset: number, text: string, _source: string): boolean => {
            const currentContent = component.content();
            const expectedLength = endOffset - startOffset;
            if (currentContent.substring(startOffset, endOffset).length !== expectedLength) {
              return false;
            }
            const nextContent =
              currentContent.substring(0, startOffset) + text + currentContent.substring(endOffset);
            component.onValueChange(nextContent);
            return true;
          },
        ),
    };
  }

  function setup(): {
    fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>;
    component: HomeComponent;
    treeExtractor: FakeTreeStringExtractor;
    snack: ExtractSnackBarStub;
    snackAction: Subject<void>;
    snackRef: MatSnackBarRef<TextOnlySnackBar>;
    editorStub: ExtractEditorStub;
    eventSpy: jasmine.Spy;
    warnSpy: jasmine.Spy;
  } {
    clearHomeStorage();
    TestBed.resetTestingModule();
    const treeExtractor = new FakeTreeStringExtractor();
    const snackRefHarness = createExtractSnackBarRefHarness();
    const snack: ExtractSnackBarStub = {
      open: jasmine.createSpy('open').and.returnValue(snackRefHarness.ref),
    };
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: MatSnackBar, useValue: snack },
        { provide: TreeStringExtractorService, useValue: treeExtractor },
      ],
    });
    const logger = TestBed.inject(LoggerService);
    const eventSpy = spyOn(logger, 'event');
    const warnSpy = spyOn(logger, 'warn');
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const editorStub = createExtractEditorStub(component);
    (component as unknown as { editor: () => ExtractEditorStub }).editor = () => editorStub;
    return {
      fixture,
      component,
      treeExtractor,
      snack,
      snackAction: snackRefHarness.action,
      snackRef: snackRefHarness.ref,
      editorStub,
      eventSpy,
      warnSpy,
    };
  }

  afterEach(() => {
    clearHomeStorage();
  });

  it('applies patched text from a tree extract request', () => {
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(1);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","keep":true}');

    component.onExtractRequest(extractRequest(extracted('{"a":1}')));

    expect(component.content()).toBe('{"payload":{"a":1},"keep":true}');
  });

  it('preserves prose when extracting the real-world Parameters[0].Value fixture', () => {
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(8);
    const rawParameterValue = readFirstParameterValue(realWorldFixtureText);
    if (typeof rawParameterValue !== 'string') {
      throw new Error('Expected fixture Parameters[0].Value to be a string');
    }
    const replacement = extractFromMixedTextCore(rawParameterValue, parseJsonCandidate);
    if (replacement === null) {
      throw new Error('Expected fixture Parameters[0].Value to be extractable');
    }
    expect(replacement.proseSegments).toBe(2);

    component.onValueChange(realWorldFixtureText);
    component.onExtractRequest(
      extractRequest(replacement, {
        path: ['Parameters', 0, 'Value'],
        sourceVersion: 8,
      }),
    );

    const patchedValue = readFirstParameterValue(component.content());
    const wrapper = requireRecord(patchedValue, 'patched Parameters[0].Value');
    const prefix = wrapper['prefix'];
    const suffix = wrapper['suffix'];
    if (typeof prefix !== 'string' || typeof suffix !== 'string') {
      throw new Error('Expected prefix and suffix strings in patched wrapper');
    }
    const json = requireRecord(wrapper['json'], 'patched json body');

    expect(prefix.trim().length).toBeGreaterThan(0);
    expect(prefix).toContain('POST https://billingservice.cp.microsoft.com');
    expect(json['ip_address']).toBe('127.0.0.1');
    expect(suffix.trim()).toBe('here is more post json text');
    expect(component.content()).toContain('"prefix"');
    expect(component.content()).toContain('"json"');
    expect(component.content()).toContain('"suffix"');
  });

  it('drops stale tree extract clicks and logs a warning', () => {
    const { component, treeExtractor, warnSpy } = setup();
    treeExtractor.setVersion(2);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}"}');
    const before = component.content();

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 1,
      }),
    );

    expect(component.content()).toBe(before);
    expect(warnSpy).toHaveBeenCalledWith('tree.extract.staleClick', {
      eventVersion: 1,
      currentVersion: 2,
    });
  });

  it('emits click telemetry after a successful tree extract request', () => {
    const { component, treeExtractor, eventSpy } = setup();
    treeExtractor.setVersion(4);
    const replacement = extracted('{"a":1}', 3, 2);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}"}');

    component.onExtractRequest(
      extractRequest(replacement, {
        sourceVersion: 4,
        source: 'contextMenu',
      }),
    );

    expect(eventSpy).toHaveBeenCalledWith(
      'tree.extract.click',
      { source: 'contextMenu' },
      { blockCount: 3, proseSegments: 2 },
    );
  });

  it('preserves comments inside the extracted replacement payload', () => {
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(5);
    component.onValueChange('{\n  "payload": "INFO {\\"a\\":1}"\n}');

    component.onExtractRequest(
      extractRequest(extracted('{\n  // inside extracted payload\n  "a": 1\n}'), {
        sourceVersion: 5,
      }),
    );

    expect(component.content()).toContain('// inside extracted payload');
    expect(component.content()).toContain('"a": 1');
  });

  it('preserves comments outside the replaced subtree', () => {
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(6);
    component.onValueChange(
      '{\n  // leading outside\n  "payload": "INFO {\\"a\\":1}", // trailing outside\n  "keep": true\n}',
    );

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 6,
      }),
    );

    expect(component.content()).toContain('// leading outside');
    expect(component.content()).toContain('"payload": {"a":1}, // trailing outside');
    expect(component.content()).toContain('"keep": true');
  });

  it('reindents multi-line extracted replacement text', () => {
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(7);
    component.onValueChange('{\n  "payload": "INFO {\\"a\\":1}"\n}');

    component.onExtractRequest(
      extractRequest(extracted('{\n  "a": 1\n}'), {
        sourceVersion: 7,
      }),
    );

    expect(component.content()).toBe('{\n  "payload": {\n               "a": 1\n             }\n}');
  });

  it('auto-expands the just-extracted node by exactly one level', () => {
    const expandSpy = spyOn(JsonTreeComponent.prototype, 'expandNodeAtPath').and.callThrough();
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(8);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","keep":true}');

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 8,
      }),
    );

    expect(expandSpy).toHaveBeenCalledOnceWith(['payload']);
  });

  it('does not expand the node when the extract is dropped as stale', () => {
    const expandSpy = spyOn(JsonTreeComponent.prototype, 'expandNodeAtPath').and.callThrough();
    const { component, treeExtractor } = setup();
    treeExtractor.setVersion(2);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}"}');

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 1,
      }),
    );

    expect(expandSpy).not.toHaveBeenCalled();
  });

  it('opens an undo snackbar after a successful tree extract request', () => {
    const { component, treeExtractor, snack } = setup();
    treeExtractor.setVersion(9);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","keep":true}');

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 9,
      }),
    );

    expect(snack.open).toHaveBeenCalledTimes(1);
    const [message, action, config] = snack.open.calls.mostRecent().args;
    expect(message).toBe('Extracted embedded JSON into the document.');
    expect(action).toBe('Undo');
    expect(config).toEqual(jasmine.objectContaining({ duration: 8000, politeness: 'assertive' }));
  });

  it('restores the prior document when the extract undo snackbar action is clicked', () => {
    const { component, treeExtractor, snackAction } = setup();
    treeExtractor.setVersion(10);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 10,
      }),
    );
    expect(component.content()).toBe('{"payload":{"a":1},"keep":true}');

    snackAction.next();

    expect(component.content()).toBe(priorText);
  });

  it('logs snackbar undo telemetry after restoring the prior document', () => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { component, treeExtractor, snackAction, eventSpy } = setup();
    treeExtractor.setVersion(11);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","keep":true}');

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 11,
      }),
    );
    eventSpy.calls.reset();

    nowMs = 2500;
    snackAction.next();

    expect(eventSpy).toHaveBeenCalledOnceWith('tree.extract.undo', {
      source: 'snackbar',
      undoLatencyMsBucket: '1-5s',
    });
  });

  it('replaces an earlier extract undo snackbar when a second extract succeeds', () => {
    const { component, treeExtractor, snack, eventSpy } = setup();
    const firstSnackRefHarness = createExtractSnackBarRefHarness();
    const secondSnackRefHarness = createExtractSnackBarRefHarness();
    snack.open.and.returnValues(firstSnackRefHarness.ref, secondSnackRefHarness.ref);
    treeExtractor.setVersion(12);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}","other":"INFO {\\"b\\":2}"}');

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 12,
      }),
    );
    eventSpy.calls.reset();

    component.onExtractRequest(
      extractRequest(extracted('{"b":2}'), {
        path: ['other'],
        source: 'contextMenu',
        sourceVersion: 12,
      }),
    );

    expect(firstSnackRefHarness.dismissSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledWith('tree.extract.snackbarReplaced');
  });

  it('logs ctrlZ undo telemetry when the document returns to the pre-extract text', () => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { fixture, component, treeExtractor, eventSpy } = setup();
    treeExtractor.setVersion(13);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 13,
      }),
    );
    eventSpy.calls.reset();

    nowMs = 1500;
    component.onValueChange(priorText);
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(eventSpy).toHaveBeenCalledWith('tree.extract.undo', {
      source: 'ctrlZ',
      undoLatencyMsBucket: '<1s',
    });
  });

  it('dismisses the live undo snackbar when ctrlZ-detected revert clears the pending state', () => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { fixture, component, treeExtractor, snack } = setup();
    const snackRefHarness = createExtractSnackBarRefHarness();
    snack.open.and.returnValue(snackRefHarness.ref);
    treeExtractor.setVersion(15);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 15,
      }),
    );

    nowMs = 1500;
    component.onValueChange(priorText);
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(snackRefHarness.dismissSpy).toHaveBeenCalled();
  });

  it('logs ctrlZ undo telemetry with the 5s+ bucket when the revert lands more than 5s after extract', () => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { fixture, component, treeExtractor, eventSpy } = setup();
    treeExtractor.setVersion(16);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 16,
      }),
    );
    eventSpy.calls.reset();

    // Stay inside the 30s wall-clock cap (the real `setTimeout` in
    // production fires at 30s and clears state); the simulated
    // `performance.now()` only drives the bucketizer.
    nowMs = 7_000;
    component.onValueChange(priorText);
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(eventSpy).toHaveBeenCalledWith('tree.extract.undo', {
      source: 'ctrlZ',
      undoLatencyMsBucket: '5s+',
    });
  });

  it('releases pendingExtractUndo state after the 30s wall-clock cap even without further edits', fakeAsync(() => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { fixture, component, treeExtractor, eventSpy, snack } = setup();
    snack.open.and.returnValue(createExtractSnackBarRefHarness().ref);
    treeExtractor.setVersion(99);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 99,
      }),
    );
    eventSpy.calls.reset();

    // Advance the real scheduler past the 30s cap. The wall-clock
    // timer scheduled in `onExtractRequest` fires and clears
    // `pendingExtractUndo` via `clearPendingExtractUndo()` regardless
    // of whether the user has typed anything.
    tick(30_001);
    fixture.detectChanges();

    // Simulate a Ctrl+Z back to priorText. The state has been
    // cleared, so the effect's content-match guard at the top
    // returns early and no `tree.extract.undo` is logged.
    nowMs = 35_000;
    component.onValueChange(priorText);
    fixture.detectChanges();
    TestBed.flushEffects();

    expect(eventSpy).not.toHaveBeenCalledWith(
      'tree.extract.undo',
      jasmine.objectContaining({ source: 'ctrlZ' }),
    );
  }));

  it('treats snackbar Undo as a no-op when ctrlZ already cleared the pending state', () => {
    let nowMs = 1000;
    spyOn(performance, 'now').and.callFake(() => nowMs);
    const { fixture, component, treeExtractor, snack, snackAction, eventSpy } = setup();
    snack.open.and.returnValue(createExtractSnackBarRefHarness().ref);
    treeExtractor.setVersion(17);
    const priorText = '{"payload":"INFO {\\"a\\":1}","keep":true}';
    component.onValueChange(priorText);

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 17,
      }),
    );

    nowMs = 2000;
    component.onValueChange(priorText);
    fixture.detectChanges();
    TestBed.flushEffects();
    eventSpy.calls.reset();

    snackAction.next();

    expect(eventSpy).not.toHaveBeenCalledWith(
      'tree.extract.undo',
      jasmine.objectContaining({ source: 'snackbar' }),
    );
  });

  it('logs applyFailed and skips the snackbar when the editor is unavailable', () => {
    const { component, treeExtractor, snack, warnSpy } = setup();
    treeExtractor.setVersion(14);
    component.onValueChange('{"payload":"INFO {\\"a\\":1}"}');
    (component as unknown as { editor: () => undefined }).editor = () => undefined;

    component.onExtractRequest(
      extractRequest(extracted('{"a":1}'), {
        sourceVersion: 14,
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith('tree.extract.applyFailed', {
      reason: 'editorUnavailable',
    });
    expect(snack.open).not.toHaveBeenCalled();
  });

  it('debounces tree string scans after treeValue changes', fakeAsync(() => {
    const { fixture, component, treeExtractor } = setup();

    component.onValueChange('{"payload":"INFO {\\"a\\":1}","other":"plain"}');
    fixture.detectChanges();
    tick(999);

    expect(treeExtractor.beginGeneration).not.toHaveBeenCalled();

    tick(1);

    expect(treeExtractor.beginGeneration).toHaveBeenCalledTimes(1);
    expect(treeExtractor.enqueueScan).toHaveBeenCalledWith(['INFO {"a":1}', 'plain']);
  }));

  it('cancels the pending tree string scan when treeValue changes again', fakeAsync(() => {
    const { fixture, component, treeExtractor } = setup();

    component.onValueChange('{"payload":"first {\\"a\\":1}"}');
    fixture.detectChanges();
    tick(500);
    component.onValueChange('{"payload":"second {\\"b\\":2}"}');
    fixture.detectChanges();
    tick(999);

    expect(treeExtractor.beginGeneration).not.toHaveBeenCalled();

    tick(1);

    expect(treeExtractor.beginGeneration).toHaveBeenCalledTimes(1);
    expect(treeExtractor.enqueueScan).toHaveBeenCalledWith(['second {"b":2}']);
  }));

  it('emits shown telemetry once the tree string scan completes', fakeAsync(() => {
    const { fixture, component, treeExtractor, eventSpy } = setup();
    treeExtractor.enqueueScan.and.callFake(() => {
      treeExtractor.scanInFlightSignal.set(true);
    });
    component.onValueChange(
      '{"a":"dup {\\"x\\":1}","b":"dup {\\"x\\":1}","c":"other {\\"y\\":2}"}',
    );
    fixture.detectChanges();
    tick(1000);

    expect(eventSpy).not.toHaveBeenCalledWith('tree.extract.shown', undefined, jasmine.any(Object));

    treeExtractor.setCandidates(
      new Map<string, ExtractedJson>([['dup {"x":1}', extracted('{"x":1}')]]),
    );
    treeExtractor.scanInFlightSignal.set(false);
    fixture.detectChanges();
    tick();

    expect(eventSpy).toHaveBeenCalledWith('tree.extract.shown', undefined, {
      uniqueStringsScanned: 2,
      uniqueCandidates: 1,
      candidateNodes: 2,
    });
  }));
});

describe('HomeComponent splash render-complete hook (Phase C)', () => {
  setupMinimalMonacoStub();

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
    localStorage.removeItem(PANE_VIS_KEY);
  });

  it('invokes LoadingSplashService.markBlobRenderComplete after a DOUBLE rAF, not a single one (paint barrier)', async () => {
    // The hook must defer past the next paint so the user actually
    // sees the "Rendering tree..." label before the splash hides.
    // A single rAF runs BEFORE the next paint and would clear the
    // splash on the same tick. This test guards against silent
    // regression to single-rAF.
    const splash = jasmine.createSpyObj<LoadingSplashService>('LoadingSplashService', [
      'markBlobRenderComplete',
    ]);
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        { provide: LoadingSplashService, useValue: splash },
      ],
    });

    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();

    // afterNextRender schedules its callback after the render
    // phases complete; let microtasks drain so the outer rAF
    // gets queued before we start waiting on rAFs.
    await Promise.resolve();

    await waitForSingleAnimationFrame();
    expect(splash.markBlobRenderComplete)
      .withContext(
        'a single rAF must NOT trigger the call - that would clear the splash before the next paint',
      )
      .not.toHaveBeenCalled();

    await waitForSingleAnimationFrame();
    expect(splash.markBlobRenderComplete)
      .withContext(
        'after the second rAF (paint barrier crossed) the hook must fire so render-pending clears',
      )
      .toHaveBeenCalledTimes(1);
  });
});
