import { TestBed } from '@angular/core/testing';
import { HomeComponent } from './home.component';
import { PreferencesService } from '../../core/preferences/preferences.service';
import { DraftService } from '../../core/preferences/draft.service';
import { provideFakeAuth } from '../../../testing/auth.testing';
import { provideRouter } from '@angular/router';

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
