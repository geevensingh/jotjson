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
import { QuotaNotificationService } from '../../core/quota/quota-notification.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
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

describe('HomeComponent blob actions (M4b)', () => {
  const PREFS_KEY = 'jotjson.preferences.v1';
  const DRAFT_KEY = 'jotjson.draft.v1';
  const SPLIT_KEY = 'jotjson.splitRatio.v1';

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

  it('onTogglePublic flips isPublic via BlobService.update and refreshes loadedBlob', async () => {
    const updated = blob({ isPublic: true });
    const { fixture, stub, snack } = setup({
      userId: 'owner-me',
      loaded: blob({ isPublic: false }),
      updateResult: updated
    }); 
      await fixture.componentInstance.onTogglePublic();
      expect(stub.update).toHaveBeenCalledWith('blob-1', { isPublic: true });
      expect(fixture.componentInstance.loadedBlob()?.isPublic).toBe(true);
      expect(snack.open).toHaveBeenCalled();
  });

  it('onTogglePublic toasts an error when the update fails', async () => {
    const { fixture, snack } = setup({
      userId: 'owner-me',
      loaded: blob(),
      updateResult: new Error('nope')
    });
    spyOn(console, 'warn'); 
      await fixture.componentInstance.onTogglePublic();
      expect(snack.open).toHaveBeenCalled();
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

