import { TestBed } from '@angular/core/testing';
import { HomeComponent } from './home.component';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { DraftService } from '../../core/preferences/draft.service';

const PREFS_KEY = 'jotjson.preferences.v1';
const DRAFT_KEY = 'jotjson.draft.v1';

describe('HomeComponent (unit-level)', () => {
  // NOTE: Full rendering of HomeComponent would load Monaco. These tests
  // exercise the component's logic without detectChanges triggering the
  // editor mount.
  beforeEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HomeComponent] });
  });

  afterEach(() => {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(DRAFT_KEY);
  });

  it('onToggleTheme cycles light → dark → system → light', () => {
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

  it('onClear() empties content', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.content.set('{"a":1}');
    fixture.componentInstance.onClear();
    expect(fixture.componentInstance.content()).toBe('');
  });

  it('onValueChange() updates content', () => {
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.componentInstance.onValueChange('{"x":42}');
    expect(fixture.componentInstance.content()).toBe('{"x":42}');
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
});
