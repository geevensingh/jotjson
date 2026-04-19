import { TestBed } from '@angular/core/testing';
import {
  PreferencesService,
  DEFAULT_PREFERENCES
} from './preferences.service';

const STORAGE_KEY = 'jotjson.preferences.v1';

describe('PreferencesService', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('uses DEFAULT_PREFERENCES when localStorage is empty', () => {
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
  });

  it('persists updates to localStorage', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark' });
    TestBed.flushEffects();
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).theme).toBe('dark');
  });

  it('hydrates from localStorage on construction', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ theme: 'light', editorFontSize: 18 })
    );
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs().theme).toBe('light');
    expect(svc.prefs().editorFontSize).toBe(18);
    // Unknown keys fall back to defaults.
    expect(svc.prefs().editorTabSize).toBe(DEFAULT_PREFERENCES.editorTabSize);
  });

  it('falls back to defaults when stored value is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const svc = TestBed.inject(PreferencesService);
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
  });

  it('reset() restores DEFAULT_PREFERENCES', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark', editorFontSize: 22 });
    svc.reset();
    expect(svc.prefs()).toEqual(DEFAULT_PREFERENCES);
  });

  it('effectiveTheme resolves explicit dark/light preference', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'dark' });
    expect(svc.effectiveTheme()).toBe('dark');
    svc.update({ theme: 'light' });
    expect(svc.effectiveTheme()).toBe('light');
  });

  it('effectiveTheme resolves "system" via matchMedia', () => {
    const svc = TestBed.inject(PreferencesService);
    svc.update({ theme: 'system' });
    const mm = window.matchMedia?.('(prefers-color-scheme: light)');
    const expected = mm?.matches ? 'light' : 'dark';
    expect(svc.effectiveTheme()).toBe(expected);
  });

  it('merges deep treeHighlightColors shape from storage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        treeHighlightColors: { dark: { selectionColor: '#123456' } }
      })
    );
    const svc = TestBed.inject(PreferencesService);
    const colors = svc.prefs().treeHighlightColors;
    // Preserves both dark and light branches from defaults.
    expect(colors.dark).toBeTruthy();
    expect(colors.light).toEqual(DEFAULT_PREFERENCES.treeHighlightColors.light);
  });
});
