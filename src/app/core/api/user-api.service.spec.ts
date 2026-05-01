import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { UserPreferences } from './models';
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
    treeAssumeUtcForIsoDateTime: false,
    treeAssumeUtcForIsoDateOnly: false,
    treeDateAnnotationUnits: {
      year: true,
      month: true,
      day: true,
      hour: true,
      minute: true,
      second: true
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
        searchHighlightColor: '#333333'
      },
      light: {
        selectionColor: '#aaaaaa',
        matchingValueColor: '#bbbbbb',
        ancestorColor: '#cccccc',
        searchHighlightColor: '#dddddd'
      }
    }
  };
}

describe('UserApiService', () => {
  let service: UserApiService;
  let httpMock: HttpTestingController;
  const base = '/api/me';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
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
      error: () => (errored = true)
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
      error: (err) => (caught = err)
    });
    const req = httpMock.expectOne(base);
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    expect(received).toBe('unset');
    expect(caught).toBeTruthy();
  });

  it('seed() POSTs preferences to /api/me', () => {
    const prefs = fakePreferences();
    service.seed(prefs).subscribe();
    const req = httpMock.expectOne(base);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ preferences: prefs });
    req.flush({});
  });

  it('putPreferences() PUTs to /api/me/preferences with the payload', () => {
    const prefs = fakePreferences();
    service.putPreferences(prefs).subscribe();
    const req = httpMock.expectOne(`${base}/preferences`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual(prefs);
    req.flush(prefs);
  });
});
