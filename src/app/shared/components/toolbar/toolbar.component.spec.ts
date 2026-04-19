import { TestBed } from '@angular/core/testing';
import { ToolbarComponent } from './toolbar.component';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { provideFakeAuth } from '../../../../testing/auth.testing';

const STORAGE_KEY = 'jotjson.preferences.v1';

describe('ToolbarComponent', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  async function create() {
    await TestBed.configureTestingModule({
      imports: [ToolbarComponent],
      providers: [...provideFakeAuth()]
    }).compileComponents();
    const fixture = TestBed.createComponent(ToolbarComponent);
    fixture.detectChanges();
    return { fixture, prefs: TestBed.inject(PreferencesService) };
  }

  it('renders without error with default prefs', async () => {
    const { fixture } = await create();
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('layoutIcon', () => {
    it('returns "layout-vertical" when layout is horizontal (shows the affordance to toggle)', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ layoutOrientation: 'horizontal' });
      fixture.detectChanges();
      expect(fixture.componentInstance.layoutIcon()).toBe('layout-vertical');
    });

    it('returns "layout-horizontal" when layout is vertical', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ layoutOrientation: 'vertical' });
      fixture.detectChanges();
      expect(fixture.componentInstance.layoutIcon()).toBe('layout-horizontal');
    });
  });

  describe('themeIcon (reads raw preference, not effectiveTheme)', () => {
    it('returns "sun" for light', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'light' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeIcon()).toBe('sun');
    });

    it('returns "moon" for dark', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'dark' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeIcon()).toBe('moon');
    });

    it('returns "system" for system (regression for 3-state toggle)', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'system' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeIcon()).toBe('system');
    });
  });

  describe('file input wiring', () => {
    it('emits upload when onFileChange receives a file', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const file = new File(['{"a":1}'], 'x.json', { type: 'application/json' });
      const input = document.createElement('input');
      input.type = 'file';
      const spy = jasmine.createSpy('upload');
      cmp.upload.subscribe(spy);

      // Simulate a change event with a file.
      Object.defineProperty(input, 'files', { value: [file] });
      cmp.onFileChange({ target: input } as unknown as Event);

      expect(spy).toHaveBeenCalledWith(file);
      expect(input.value).toBe('');
    });

    it('does not emit upload when no file is selected', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const input = document.createElement('input');
      input.type = 'file';
      const spy = jasmine.createSpy('upload');
      cmp.upload.subscribe(spy);
      cmp.onFileChange({ target: input } as unknown as Event);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('onModeChange emits the new mode', async () => {
    const { fixture } = await create();
    const cmp = fixture.componentInstance;
    const spy = jasmine.createSpy('modeChange');
    cmp.modeChange.subscribe(spy);
    cmp.onModeChange('jsonc');
    expect(spy).toHaveBeenCalledWith('jsonc');
  });
});
