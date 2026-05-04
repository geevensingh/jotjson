import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { UserPreferences } from './models';
import type { PreferencesWithEtag, UserWithEtag } from './user-api.service';
import { UserApiService } from './user-api.service';

function fakePreferences(): UserPreferences {
  return {
    theme: 'system',
    editorFontSize: 14,
    editorTabSize: 2,
    defaultTreeExpansionDepth: 2,
    activeRuleSetIds: [],
    editorWordWrap: true,
    layoutOrientation: 'horizontal',
    treeFontSize: 14,
    treeShowTypeLabels: true,
    treeShowDateAnnotations: true,
    treeShowComments: true,
    treeAssumeUtcForIsoDateTime: false,
    treeAssumeUtcForIsoDateOnly: false,
    treeDateAnnotationUnits: {
      year: true,
      month: true,
      day: true,
      hour: true,
      minute: true,
      second: true,
    },
    treeDateAnnotationFriendlyForms: true,
    recentlyViewedEnabled: true,
    treeEditorSelectionSync: true,
    treeAutoFitToWindow: true,
    searchCaseSensitive: false,
    searchRegexMode: false,
    searchScope: 'both',
    searchValueType: 'all',
    blobQuotaStrategy: 'auto_fifo',
    seenBlobQuotaModal: false,
    seenClipboardBanner: false,
    treePathRoot: 'jsonpath',
    treeHighlightColors: {
      dark: {
        selectionColor: '#000000',
        matchingValueColor: '#111111',
        ancestorColor: '#222222',
        searchHighlightColor: '#333333',
        manualHighlightColor: '#444444',
      },
      light: {
        selectionColor: '#aaaaaa',
        matchingValueColor: '#bbbbbb',
        ancestorColor: '#cccccc',
        searchHighlightColor: '#dddddd',
        manualHighlightColor: '#eeeeee',
      },
    },
  };
}

describe('UserApiService', () => {
  let service: UserApiService;
  let httpMock: HttpTestingController;
  const base = '/api/me';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UserApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('getMe() returns null when server responds 404', () => {
    let received: unknown = 'unset';
    let errored = false;
    service.getMe().subscribe({
      next: (value) => (received = value),
      error: () => (errored = true),
    });
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('GET');
    req.flush('not found', { status: 404, statusText: 'Not Found' });
    expect(received).toBeNull();
    expect(errored).toBe(false);
  });

  it('getMe() propagates non-404 errors (500 errors out the observable)', () => {
    let received: unknown = 'unset';
    let caught: unknown = null;
    service.getMe().subscribe({
      next: (value) => (received = value),
      error: (err) => (caught = err),
    });
    const req = httpMock.expectOne(base);
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    expect(received).toBe('unset');
    expect(caught).toBeTruthy();
  });

  it('getMe() returns the user body and ETag when present', () => {
    let received: UserWithEtag | null | 'unset' = 'unset';
    service.getMe().subscribe({
      next: (value) => (received = value),
    });
    const req = httpMock.expectOne(base);
    const body = {
      id: 'u-1',
      displayName: 'Alice',
      email: 'a@b.com',
      createdAt: 't',
      plan: 'free' as const,
      preferences: fakePreferences(),
    };
    req.flush(body, { status: 200, statusText: 'OK', headers: { ETag: '"3"' } });
    expect(received).not.toBe('unset');
    expect(received).not.toBeNull();
    if (received !== null && received !== 'unset') {
      const wrapper = received as UserWithEtag;
      expect(wrapper.user).toEqual(body);
      expect(wrapper.etag).toBe('"3"');
    }
  });

  it('getMe() returns null etag when server omits ETag header', () => {
    let received: UserWithEtag | null | 'unset' = 'unset';
    service.getMe().subscribe({
      next: (value) => (received = value),
    });
    const req = httpMock.expectOne(base);
    req.flush(
      {
        id: 'u-1',
        displayName: 'Alice',
        email: 'a@b.com',
        createdAt: 't',
        plan: 'free',
        preferences: fakePreferences(),
      },
      { status: 200, statusText: 'OK' },
    );
    if (received !== null && received !== 'unset') {
      const wrapper = received as UserWithEtag;
      expect(wrapper.etag).toBeNull();
    } else {
      fail('expected response wrapper');
    }
  });

  it('seed() POSTs preferences to /api/me and returns ETag', () => {
    const prefs = fakePreferences();
    let received: UserWithEtag | 'unset' = 'unset';
    service.seed(prefs).subscribe({
      next: (value) => (received = value),
    });
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ preferences: prefs });
    req.flush(
      {
        id: 'u-1',
        displayName: 'Alice',
        email: 'a@b.com',
        createdAt: 't',
        plan: 'free',
        preferences: prefs,
      },
      { status: 201, statusText: 'Created', headers: { ETag: '"1"' } },
    );
    if (received !== 'unset') {
      const wrapper = received as UserWithEtag;
      expect(wrapper.etag).toBe('"1"');
    } else {
      fail('expected response wrapper');
    }
  });

  it('putPreferences() PUTs to /api/me/preferences with the If-Match header', () => {
    const prefs = fakePreferences();
    let received: PreferencesWithEtag | 'unset' = 'unset';
    service.putPreferences(prefs, '"3"').subscribe({
      next: (value) => (received = value),
    });
    const req = httpMock.expectOne(`${base}/preferences`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(prefs);
    expect(req.request.headers.get('If-Match')).toBe('"3"');
    req.flush(prefs, { status: 200, statusText: 'OK', headers: { ETag: '"4"' } });
    if (received !== 'unset') {
      const wrapper = received as PreferencesWithEtag;
      expect(wrapper.etag).toBe('"4"');
    } else {
      fail('expected response wrapper');
    }
  });

  it('putPreferences() propagates 412 conflicts', () => {
    const prefs = fakePreferences();
    let caught: unknown = null;
    service.putPreferences(prefs, '"1"').subscribe({
      error: (err) => (caught = err),
    });
    const req = httpMock.expectOne(`${base}/preferences`);
    req.flush('precondition failed', { status: 412, statusText: 'Precondition Failed' });
    expect(caught).toBeTruthy();
  });
});
