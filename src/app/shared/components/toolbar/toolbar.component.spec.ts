import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ToolbarComponent } from './toolbar.component';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { AuthService } from '../../../core/auth/auth.service';
import { provideFakeAuth, signInFakeUser } from '../../../../testing/auth.testing';

const STORAGE_KEY = 'jotjson.preferences.v1';

describe('ToolbarComponent', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  async function create(opts: { signedIn?: boolean } = {}) {
    await TestBed.configureTestingModule({
      imports: [ToolbarComponent],
      providers: [...provideFakeAuth(), provideRouter([])]
    }).compileComponents();
    const fixture = TestBed.createComponent(ToolbarComponent);
    const auth = TestBed.inject(AuthService);
    if (opts.signedIn) {
      signInFakeUser(auth);
    }
    fixture.detectChanges();
    return { fixture, prefs: TestBed.inject(PreferencesService), auth };
  }

  it('renders without error with default prefs', async () => {
    const { fixture } = await create();
    expect(fixture.componentInstance).toBeTruthy();
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

  describe('selection sync toggle (issue #42)', () => {
    function findSyncButton(fixture: ComponentFixture<ToolbarComponent>): HTMLButtonElement {
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        'button[aria-label="Toggle tree-editor selection sync"]'
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error('selection-sync toggle button not found in toolbar');
      }
      return button;
    }

    it('selectionSyncEnabled mirrors the pref (default true)', async () => {
      const { fixture } = await create();
      expect(fixture.componentInstance.selectionSyncEnabled()).toBeTrue();
    });

    it('selectionSyncIcon = "arrows-exchange" when enabled, "arrows-exchange-off" when disabled', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ treeEditorSelectionSync: true });
      fixture.detectChanges();
      expect(fixture.componentInstance.selectionSyncIcon()).toBe('arrows-exchange');
      prefs.update({ treeEditorSelectionSync: false });
      fixture.detectChanges();
      expect(fixture.componentInstance.selectionSyncIcon()).toBe('arrows-exchange-off');
    });

    it('aria-pressed reflects the pref state', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ treeEditorSelectionSync: true });
      fixture.detectChanges();
      expect(findSyncButton(fixture).getAttribute('aria-pressed')).toBe('true');
      prefs.update({ treeEditorSelectionSync: false });
      fixture.detectChanges();
      expect(findSyncButton(fixture).getAttribute('aria-pressed')).toBe('false');
    });

    it('tooltip varies with state', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ treeEditorSelectionSync: true });
      fixture.detectChanges();
      expect(fixture.componentInstance.selectionSyncTooltip()).toMatch(/disable/i);
      prefs.update({ treeEditorSelectionSync: false });
      fixture.detectChanges();
      expect(fixture.componentInstance.selectionSyncTooltip()).toMatch(/enable/i);
    });

    it('clicking the button emits toggleSelectionSync', async () => {
      const { fixture } = await create();
      let clickCount = 0;
      fixture.componentInstance.toggleSelectionSync.subscribe(() => clickCount++);
      findSyncButton(fixture).click();
      expect(clickCount).toBe(1);
    });
  });

  describe('pane layout segmented control (issue #39 follow-up)', () => {
    function findGroup(
      fixture: ComponentFixture<ToolbarComponent>
    ): HTMLElement {
      const group = (fixture.nativeElement as HTMLElement).querySelector(
        'mat-button-toggle-group.pane-layout-group'
      );
      if (!group) {
        throw new Error('pane-layout group not found in toolbar');
      }
      return group as HTMLElement;
    }

    function findSegment(
      fixture: ComponentFixture<ToolbarComponent>,
      value: string
    ): HTMLButtonElement {
      const segment = findGroup(fixture).querySelector(
        `mat-button-toggle[value="${value}"] button`
      );
      if (!segment) {
        throw new Error(`segment "${value}" not found in pane-layout group`);
      }
      return segment as HTMLButtonElement;
    }

    it('renders all 4 segments in continuum order with their state-icons', async () => {
      const { fixture } = await create();
      const group = findGroup(fixture);
      const segments = Array.from(
        group.querySelectorAll('mat-button-toggle')
      );

      expect(segments.length).toBe(4);
      expect(segments[0].getAttribute('value')).toBe('editor-only');
      expect(segments[1].getAttribute('value')).toBe('both-horizontal');
      expect(segments[2].getAttribute('value')).toBe('both-vertical');
      expect(segments[3].getAttribute('value')).toBe('tree-only');

      // Each segment renders the icon depicting its target state.
      expect(segments[0].querySelector('jj-icon')).toBeTruthy();
      expect(segments[1].querySelector('jj-icon')).toBeTruthy();
      expect(segments[2].querySelector('jj-icon')).toBeTruthy();
      expect(segments[3].querySelector('jj-icon')).toBeTruthy();
    });

    it('group aria-label is set', async () => {
      const { fixture } = await create();
      const group = findGroup(fixture);
      expect(group.getAttribute('aria-label')?.toLowerCase()).toBe(
        'pane layout'
      );
    });

    it('segment tooltips and aria-labels describe their target state', async () => {
      const { fixture } = await create();
      const c = fixture.componentInstance;

      // The static labels drive both the matTooltip directive
      // bindings and the [attr.aria-label]; we assert the values
      // the component exposes, then confirm the aria-label is
      // rendered on the DOM (matTooltip is not reflected as a
      // plain HTML attribute, only the directive carries it).
      expect(c.paneLayoutEditorOnlyLabel.toLowerCase()).toContain(
        'editor only'
      );
      expect(c.paneLayoutBothHorizontalLabel.toLowerCase()).toContain(
        'side-by-side'
      );
      expect(c.paneLayoutBothVerticalLabel.toLowerCase()).toContain('above');
      expect(c.paneLayoutTreeOnlyLabel.toLowerCase()).toContain('tree only');

      const group = findGroup(fixture);
      const segments = Array.from(
        group.querySelectorAll('mat-button-toggle')
      );
      // Material's <mat-button-toggle> nulls out its own host
      // aria-label and forwards the user's value to the inner
      // <button>. Read it from there.
      const ariaFor = (value: string) => {
        const seg = segments.find(
          (s) => s.getAttribute('value') === value
        );
        return (
          seg?.querySelector('button')?.getAttribute('aria-label') ?? ''
        );
      };

      expect(ariaFor('editor-only')).toBe(c.paneLayoutEditorOnlyLabel);
      expect(ariaFor('both-horizontal')).toBe(
        c.paneLayoutBothHorizontalLabel
      );
      expect(ariaFor('both-vertical')).toBe(c.paneLayoutBothVerticalLabel);
      expect(ariaFor('tree-only')).toBe(c.paneLayoutTreeOnlyLabel);
    });

    it('group [value] reflects the paneLayout input', async () => {
      const { fixture } = await create();
      for (const value of [
        'editor-only',
        'both-horizontal',
        'both-vertical',
        'tree-only'
      ] as const) {
        fixture.componentRef.setInput('paneLayout', value);
        fixture.detectChanges();
        const checked = (fixture.nativeElement as HTMLElement).querySelector(
          'mat-button-toggle-group.pane-layout-group .mat-button-toggle-checked'
        );
        expect(checked?.getAttribute('value')).toBe(value);
      }
    });

    it('clicking each segment emits paneLayoutChange with that value', async () => {
      const { fixture } = await create();
      // Start in both-horizontal so that each click is a real change.
      fixture.componentRef.setInput('paneLayout', 'both-horizontal');
      fixture.detectChanges();

      const emitted: string[] = [];
      fixture.componentInstance.paneLayoutChange.subscribe((value) => {
        emitted.push(value);
      });

      for (const value of [
        'editor-only',
        'both-vertical',
        'tree-only',
        'both-horizontal'
      ] as const) {
        // Mirror what the parent does after each emission so the next
        // click is also a change.
        findSegment(fixture, value).click();
        fixture.componentRef.setInput('paneLayout', value);
        fixture.detectChanges();
      }

      expect(emitted).toEqual([
        'editor-only',
        'both-vertical',
        'tree-only',
        'both-horizontal'
      ]);
    });

    it('re-clicking the already-active segment does NOT emit paneLayoutChange', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('paneLayout', 'both-horizontal');
      fixture.detectChanges();

      let emitCount = 0;
      fixture.componentInstance.paneLayoutChange.subscribe(() => {
        emitCount++;
      });

      // Click the segment that is already active.
      findSegment(fixture, 'both-horizontal').click();
      fixture.detectChanges();

      expect(emitCount).toBe(0);
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

  it('copyRequested output fires when button click is translated (direct emit path)', async () => {
    const { fixture } = await create();
    const cmp = fixture.componentInstance;
    const spy = jasmine.createSpy('copyRequested');
    cmp.copyRequested.subscribe(spy);
    cmp.copyRequested.emit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('onCopyClick', () => {
    it('emits copyRequested on a plain click', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const copy = jasmine.createSpy('copyRequested');
      const copyEscaped = jasmine.createSpy('copyEscaped');
      cmp.copyRequested.subscribe(copy);
      cmp.copyEscaped.subscribe(copyEscaped);
      cmp.onCopyClick(new MouseEvent('click', { altKey: false }));
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copyEscaped).not.toHaveBeenCalled();
    });

    it('emits copyEscaped when Alt is held', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const copy = jasmine.createSpy('copyRequested');
      const copyEscaped = jasmine.createSpy('copyEscaped');
      cmp.copyRequested.subscribe(copy);
      cmp.copyEscaped.subscribe(copyEscaped);
      cmp.onCopyClick(new MouseEvent('click', { altKey: true }));
      expect(copyEscaped).toHaveBeenCalledTimes(1);
      expect(copy).not.toHaveBeenCalled();
    });
  });

  describe('save button / title field (M4a)', () => {
    it('saveDisabled is true when canSave is false', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', false);
      fixture.componentRef.setInput('hasContent', true);
      fixture.componentRef.setInput('saveInFlight', false);
      fixture.detectChanges();
      expect(fixture.componentInstance.saveDisabled()).toBe(true);
    });

    it('saveDisabled is true when saveInFlight is true even if canSave', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', true);
      fixture.componentRef.setInput('hasContent', true);
      fixture.componentRef.setInput('saveInFlight', true);
      fixture.detectChanges();
      expect(fixture.componentInstance.saveDisabled()).toBe(true);
    });

    it('saveDisabled is false when canSave and hasContent and not in flight', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', true);
      fixture.componentRef.setInput('hasContent', true);
      fixture.componentRef.setInput('saveInFlight', false);
      fixture.detectChanges();
      expect(fixture.componentInstance.saveDisabled()).toBe(false);
    });

    it('onTitleInput emits titleChange with the new value', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const spy = jasmine.createSpy('titleChange');
      cmp.titleChange.subscribe(spy);
      const input = document.createElement('input');
      input.value = 'My JSON';
      cmp.onTitleInput({ target: input } as unknown as Event);
      expect(spy).toHaveBeenCalledWith('My JSON');
    });

    it('onTitleKeydown emits save on Enter when enabled', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', true);
      fixture.componentRef.setInput('hasContent', true);
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      const spy = jasmine.createSpy('save');
      cmp.save.subscribe(spy);
      const ev = new KeyboardEvent('keydown', { key: 'Enter' });
      cmp.onTitleKeydown(ev);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('onTitleKeydown does not emit save on Enter when disabled', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', false);
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      const spy = jasmine.createSpy('save');
      cmp.save.subscribe(spy);
      const ev = new KeyboardEvent('keydown', { key: 'Enter' });
      cmp.onTitleKeydown(ev);
      expect(spy).not.toHaveBeenCalled();
    });

    it('onTitleKeydown ignores non-Enter keys', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('canSave', true);
      fixture.componentRef.setInput('hasContent', true);
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      const spy = jasmine.createSpy('save');
      cmp.save.subscribe(spy);
      cmp.onTitleKeydown(new KeyboardEvent('keydown', { key: 'a' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('native paste into the title input does NOT trigger the pasteRequested output (regression)', async () => {
      const { fixture } = await create({ signedIn: true });
      const cmp = fixture.componentInstance;
      const pasteSpy = jasmine.createSpy('pasteRequested');
      const copySpy = jasmine.createSpy('copyRequested');
      cmp.pasteRequested.subscribe(pasteSpy);
      cmp.copyRequested.subscribe(copySpy);

      const host: HTMLElement = fixture.nativeElement;
      const titleInput = host.querySelector<HTMLInputElement>('input.title-field');
      expect(titleInput).toBeTruthy();
      titleInput!.dispatchEvent(new Event('paste', { bubbles: true }));
      titleInput!.dispatchEvent(new Event('copy', { bubbles: true }));

      expect(pasteSpy).not.toHaveBeenCalled();
      expect(copySpy).not.toHaveBeenCalled();
    });
  });

  describe('overflow menu (M4b)', () => {
    it('showOverflowMenu is false by default (isOwner=false)', async () => {
      const { fixture } = await create();
      expect(fixture.componentInstance.showOverflowMenu()).toBe(false);
    });

    it('showOverflowMenu is true when isOwner is true', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('isOwner', true);
      fixture.detectChanges();
      expect(fixture.componentInstance.showOverflowMenu()).toBe(true);
    });

    it('visibilityMenuLabel flips based on isPublic', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('isPublic', false);
      fixture.detectChanges();
      expect(fixture.componentInstance.visibilityMenuLabel()).toBe('Make public');
      fixture.componentRef.setInput('isPublic', true);
      fixture.detectChanges();
      expect(fixture.componentInstance.visibilityMenuLabel()).toBe('Make private');
    });

    it('copyShareLink, togglePublic, deleteBlob outputs emit when invoked', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const copy = jasmine.createSpy('copyShareLink');
      const toggle = jasmine.createSpy('togglePublic');
      const del = jasmine.createSpy('deleteBlob');
      cmp.copyShareLink.subscribe(copy);
      cmp.togglePublic.subscribe(toggle);
      cmp.deleteBlob.subscribe(del);
      cmp.copyShareLink.emit();
      cmp.togglePublic.emit();
      cmp.deleteBlob.emit();
      expect(copy).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveBeenCalledTimes(1);
      expect(del).toHaveBeenCalledTimes(1);
    });
  });

  describe('signed-out visibility (anonymous users)', () => {
    it('does not render the title input or save button when signed out', async () => {
      const { fixture } = await create();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector('input.title-field')).toBeNull();
      expect(host.querySelector('jj-icon[name="save"]')).toBeNull();
    });

    it('renders the title input and save button when signed in', async () => {
      const { fixture } = await create({ signedIn: true });
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector('input.title-field')).toBeTruthy();
      expect(host.querySelector('jj-icon[name="save"]')).toBeTruthy();
    });
  });

  describe('clipboard state (M7a)', () => {
    it('fallback state: enabled, default tooltip, no ready class', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('clipboardState', 'fallback');
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      expect(cmp.pasteDisabled()).toBe(false);
      expect(cmp.pasteTooltip()).toBe('Paste from clipboard');
      const btn = (fixture.nativeElement as HTMLElement).querySelector(
        'button.paste-ready'
      );
      expect(btn).toBeNull();
    });

    it('enabled-json: enabled, ready class, tooltip includes preview', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('clipboardState', 'enabled-json');
      fixture.componentRef.setInput('clipboardPreview', '{"a":1}');
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      expect(cmp.pasteDisabled()).toBe(false);
      expect(cmp.pasteTooltip()).toContain('{"a":1}');
      const btn = (fixture.nativeElement as HTMLElement).querySelector(
        'button.paste-ready'
      );
      expect(btn).toBeTruthy();
    });

    it('enabled-empty: disabled, tooltip explains clipboard has no JSON', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('clipboardState', 'enabled-empty');
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      expect(cmp.pasteDisabled()).toBe(true);
      expect(cmp.pasteTooltip()).toBe('Clipboard does not contain JSON');
    });

    it('denied: disabled with instructive tooltip', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('clipboardState', 'denied');
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      expect(cmp.pasteDisabled()).toBe(true);
      expect(cmp.pasteTooltip()).toContain('Ctrl+V');
    });

    it('still emits pasteRequested in fallback state', async () => {
      const { fixture } = await create();
      fixture.componentRef.setInput('clipboardState', 'fallback');
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      const spy = jasmine.createSpy('pasteRequested');
      cmp.pasteRequested.subscribe(spy);
      cmp.pasteRequested.emit();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
