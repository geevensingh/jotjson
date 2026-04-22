import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';
import { HomeComponent } from './home.component';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { DraftService } from '../../core/preferences/draft.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { provideRouter, Router } from '@angular/router';
import { BlobService } from '../../core/api/blob.service';
import { AuthService } from '../../core/auth/auth.service';
import type { JsonBlob } from '../../core/api/models';

const PREFS_KEY = 'jotjson.preferences.v1';
const DRAFT_KEY = 'jotjson.draft.v1';
const SPLIT_KEY = 'jotjson.splitRatio.v1';

describe('HomeComponent (unit-level)', () => {
  // NOTE: Full rendering of HomeComponent would load Monaco. These tests
  // exercise the component's logic without detectChanges triggering the
  // editor mount.
  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
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

  it('onToggleLayout swaps layoutOrientation', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    const prefs = TestBed.inject(PreferencesService);
    prefs.update({ layoutOrientation: 'horizontal' });
    fixture.componentInstance.onToggleLayout();
    expect(prefs.prefs().layoutOrientation).toBe('vertical');
    fixture.componentInstance.onToggleLayout();
    expect(prefs.prefs().layoutOrientation).toBe('horizontal');
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
    expect(fixture.componentInstance.content()).toBe(text);
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
});

describe('HomeComponent save() branching (M4a)', () => {
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

  function setup(opts: {
    userId: string | null;
    createResult?: JsonBlob | Error;
    updateResult?: JsonBlob | Error;
  }): { fixture: ReturnType<typeof TestBed.createComponent<HomeComponent>>; stub: StubBlobService; router: Router } {
    localStorage.removeItem('jotjson.preferences.v1');
    localStorage.removeItem('jotjson.draft.v1');
    localStorage.removeItem('jotjson.splitRatio.v1');
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
        { provide: AuthService, useValue: fakeAuth }
      ]
    });

    const fixture = TestBed.createComponent(HomeComponent);
    return { fixture, stub, router: TestBed.inject(Router) };
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

  it('create path: signed-in user with no loaded blob calls create and navigates to /s/:slug', async () => {
    const created = blob({ id: 'new-id', slug: 'newslug', ownerId: 'u1' });
    const { fixture, stub, router } = setup({ userId: 'u1', createResult: created });
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.content.set('{"x":1}');
    fixture.componentInstance.title.set('My title');
    await fixture.componentInstance.onSave();
    expect(stub.create).toHaveBeenCalledWith('{"x":1}', 'My title', false);
    expect(fixture.componentInstance.loadedBlob()).toEqual(created);
    expect(navSpy).toHaveBeenCalledWith(['/s', 'newslug']);
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

  it('update path: owner updates in place (same slug, no navigation)', async () => {
    const updated = blob({ id: 'id-1', slug: 'slug-1', ownerId: 'u1', title: 'New' });
    const { fixture, stub, router } = setup({ userId: 'u1', updateResult: updated });
    const navSpy = spyOn(router, 'navigate').and.resolveTo(true);
    fixture.componentInstance.loadedBlob.set(blob({ id: 'id-1', ownerId: 'u1' }));
    fixture.componentInstance.content.set('{"a":2}');
    fixture.componentInstance.title.set('New');
    await fixture.componentInstance.onSave();
    expect(stub.update).toHaveBeenCalledWith('id-1', { content: '{"a":2}', title: 'New' });
    expect(stub.create).not.toHaveBeenCalled();
    expect(navSpy).not.toHaveBeenCalled();
    expect(fixture.componentInstance.loadedBlob()).toEqual(updated);
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
});

describe('HomeComponent browser-title effect (M4a)', () => {
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';

  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(SPLIT_KEY);
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
    fixture.componentInstance.title.set('');
    fixture.componentRef.changeDetectorRef.detectChanges();
    TestBed.flushEffects();
    expect(spy).toHaveBeenCalledWith('Untitled | JotJSON');
  });
});
