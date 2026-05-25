import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { type Mocked, type MockInstance } from 'vitest';
import { provideFakeAuth, signInFakeUser } from '../../../../testing/auth.testing';
import { AuthService } from '../../../core/auth/auth.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { LoggerService } from '../../../core/telemetry/logger.service';
import { ToolbarComponent } from './toolbar.component';

const STORAGE_KEY = 'jotjson.preferences.v1';

type ToolbarAction =
  | 'paste'
  | 'copy'
  | 'copyEscaped'
  | 'openFile'
  | 'download'
  | 'format'
  | 'minify'
  | 'sort'
  | 'clear'
  | 'save'
  | 'copyShareLink'
  | 'togglePublic'
  | 'deleteBlob'
  | 'fileChange';

describe('ToolbarComponent', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  async function create(options: { signedIn?: boolean } = {}) {
    const logger = { event: vi.fn() } as Mocked<LoggerService>;
    await TestBed.configureTestingModule({
      imports: [ToolbarComponent],
      providers: [
        ...provideFakeAuth(),
        provideRouter([]),
        provideNoopAnimations(),
        { provide: LoggerService, useValue: logger },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ToolbarComponent);
    const auth = TestBed.inject(AuthService);
    if (options.signedIn) {
      signInFakeUser(auth);
    }
    fixture.detectChanges();
    return { fixture, prefs: TestBed.inject(PreferencesService), auth, logger };
  }

  type ToolbarInputOptions = {
    readonly hasContent?: boolean;
    readonly title?: string;
    readonly canSave?: boolean;
    readonly isSavedBlob?: boolean;
    readonly isDirty?: boolean;
    readonly saveInFlight?: boolean;
    readonly loadedBlobTitle?: string | null;
    readonly isOwner?: boolean;
  };

  function setToolbarInputs(
    fixture: ComponentFixture<ToolbarComponent>,
    inputs: ToolbarInputOptions,
  ): void {
    const componentRef = fixture.componentRef;
    if (inputs.hasContent !== undefined) {
      componentRef.setInput('hasContent', inputs.hasContent);
    }
    if (inputs.title !== undefined) {
      componentRef.setInput('title', inputs.title);
    }
    if (inputs.canSave !== undefined) {
      componentRef.setInput('canSave', inputs.canSave);
    }
    if (inputs.isSavedBlob !== undefined) {
      componentRef.setInput('isSavedBlob', inputs.isSavedBlob);
    }
    if (inputs.isDirty !== undefined) {
      componentRef.setInput('isDirty', inputs.isDirty);
    }
    if (inputs.saveInFlight !== undefined) {
      componentRef.setInput('saveInFlight', inputs.saveInFlight);
    }
    if (inputs.loadedBlobTitle !== undefined) {
      componentRef.setInput('loadedBlobTitle', inputs.loadedBlobTitle);
    }
    if (inputs.isOwner !== undefined) {
      componentRef.setInput('isOwner', inputs.isOwner);
    }
    fixture.detectChanges();
  }

  function queryByCss<TElement extends Element>(
    fixture: ComponentFixture<ToolbarComponent>,
    selector: string,
  ): TElement | null {
    const debugElement = fixture.debugElement.query(By.css(selector));
    if (!debugElement) return null;
    return debugElement.nativeElement as TElement;
  }

  function queryAllByCss<TElement extends Element>(
    fixture: ComponentFixture<ToolbarComponent>,
    selector: string,
  ): TElement[] {
    return fixture.debugElement
      .queryAll(By.css(selector))
      .map((debugElement) => debugElement.nativeElement as TElement);
  }

  function requireByCss<TElement extends Element>(
    fixture: ComponentFixture<ToolbarComponent>,
    selector: string,
  ): TElement {
    const element = queryByCss<TElement>(fixture, selector);
    if (!element) {
      throw new Error(`expected element matching "${selector}"`);
    }
    return element;
  }

  function normalizedText(element: Element): string {
    return element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  function findSaveButton(fixture: ComponentFixture<ToolbarComponent>): HTMLButtonElement {
    return requireByCss<HTMLButtonElement>(fixture, 'button.save-button');
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

  describe('themeToggleLabel (predictive 3-state tooltip + aria-label, M7f-2)', () => {
    function findThemeButton(fixture: ComponentFixture<ToolbarComponent>): HTMLButtonElement {
      const themeLabels = new Set([
        'Switch to light theme',
        'Switch to dark theme',
        'Match system theme',
      ]);
      const button = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
      ).find((candidateButton) =>
        themeLabels.has(candidateButton.getAttribute('aria-label') ?? ''),
      );
      if (!button) {
        throw new Error('theme toggle button not found');
      }
      return button;
    }

    it('shows "Switch to dark theme" when current theme is light', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'light' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeToggleLabel()).toBe('Switch to dark theme');
      expect(findThemeButton(fixture).getAttribute('aria-label')).toBe('Switch to dark theme');
    });

    it('shows "Match system theme" when current theme is dark (matches Profile dropdown copy)', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'dark' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeToggleLabel()).toBe('Match system theme');
      expect(findThemeButton(fixture).getAttribute('aria-label')).toBe('Match system theme');
    });

    it('shows "Switch to light theme" when current theme is system', async () => {
      const { fixture, prefs } = await create();
      prefs.update({ theme: 'system' });
      fixture.detectChanges();
      expect(fixture.componentInstance.themeToggleLabel()).toBe('Switch to light theme');
      expect(findThemeButton(fixture).getAttribute('aria-label')).toBe('Switch to light theme');
    });
  });

  describe('M7f-4a state-pill--modified uses Material 21 semantic token', () => {
    it('references --mat-sys-secondary-container so it auto-flips between dark and light themes', async () => {
      // Mount a fixture so Angular emits the toolbar component's
      // scoped SCSS into document.styleSheets. Then iterate the
      // stylesheet rules and assert that the rule for
      // .state-pill--modified references the Material 21
      // secondary-container token. Previous hardcoded
      // #ffecb3 / #4a3000 washed out in dark mode.
      const { fixture } = await create();
      fixture.detectChanges();

      const matches: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          const text = rule.cssText;
          if (
            text.includes('state-pill--modified') &&
            text.includes('--mat-sys-secondary-container')
          ) {
            matches.push(text);
          }
        }
      }
      expect(
        matches.length,
        'M7f-4a: .state-pill--modified must reference --mat-sys-secondary-container so it auto-flips between dark and light themes (was hardcoded #ffecb3 / #4a3000 - washed out in dark)',
      ).toBeGreaterThan(0);

      // Negative regression: no bare hardcoded hex without the
      // semantic-token fallback.
      const offenders: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (!(rule instanceof CSSStyleRule)) continue;
          const text = rule.cssText;
          if (text.includes('state-pill--modified') && text.includes('background: #ffecb3;')) {
            offenders.push(text);
          }
        }
      }
      expect(
        offenders.length,
        'M7f-4a regression guard: .state-pill--modified must not have a bare hardcoded #ffecb3 without --mat-sys-secondary-container fallback',
      ).toBe(0);
    });
  });

  describe('selection sync toggle (issue #42)', () => {
    function findSyncButton(fixture: ComponentFixture<ToolbarComponent>): HTMLButtonElement {
      const button = (fixture.nativeElement as HTMLElement).querySelector(
        'button[aria-label="Toggle tree-editor selection sync"]',
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error('selection-sync toggle button not found in toolbar');
      }
      return button;
    }

    it('selectionSyncEnabled mirrors the pref (default true)', async () => {
      const { fixture } = await create();
      expect(fixture.componentInstance.selectionSyncEnabled()).toBe(true);
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
    function findGroup(fixture: ComponentFixture<ToolbarComponent>): HTMLElement {
      const group = (fixture.nativeElement as HTMLElement).querySelector(
        'mat-button-toggle-group.pane-layout-group',
      );
      if (!group) {
        throw new Error('pane-layout group not found in toolbar');
      }
      return group as HTMLElement;
    }

    function findSegment(
      fixture: ComponentFixture<ToolbarComponent>,
      value: string,
    ): HTMLButtonElement {
      const segment = findGroup(fixture).querySelector(
        `mat-button-toggle[value="${value}"] button`,
      );
      if (!segment) {
        throw new Error(`segment "${value}" not found in pane-layout group`);
      }
      return segment as HTMLButtonElement;
    }

    it('renders all 4 segments in continuum order with their state-icons', async () => {
      const { fixture } = await create();
      const group = findGroup(fixture);
      const segments = Array.from(group.querySelectorAll('mat-button-toggle'));

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
      expect(group.getAttribute('aria-label')?.toLowerCase()).toBe('pane layout');
    });

    it('segment tooltips and aria-labels describe their target state', async () => {
      const { fixture } = await create();
      const c = fixture.componentInstance;

      // The static labels drive both the matTooltip directive
      // bindings and the [attr.aria-label]; we assert the values
      // the component exposes, then confirm the aria-label is
      // rendered on the DOM (matTooltip is not reflected as a
      // plain HTML attribute, only the directive carries it).
      expect(c.paneLayoutEditorOnlyLabel.toLowerCase()).toContain('editor only');
      expect(c.paneLayoutBothHorizontalLabel.toLowerCase()).toContain('side-by-side');
      expect(c.paneLayoutBothVerticalLabel.toLowerCase()).toContain('above');
      expect(c.paneLayoutTreeOnlyLabel.toLowerCase()).toContain('tree only');

      const group = findGroup(fixture);
      const segments = Array.from(group.querySelectorAll('mat-button-toggle'));
      // Material's <mat-button-toggle> nulls out its own host
      // aria-label and forwards the user's value to the inner
      // <button>. Read it from there.
      const ariaFor = (value: string) => {
        const seg = segments.find((s) => s.getAttribute('value') === value);
        return seg?.querySelector('button')?.getAttribute('aria-label') ?? '';
      };

      expect(ariaFor('editor-only')).toBe(c.paneLayoutEditorOnlyLabel);
      expect(ariaFor('both-horizontal')).toBe(c.paneLayoutBothHorizontalLabel);
      expect(ariaFor('both-vertical')).toBe(c.paneLayoutBothVerticalLabel);
      expect(ariaFor('tree-only')).toBe(c.paneLayoutTreeOnlyLabel);
    });

    it('group [value] reflects the paneLayout input', async () => {
      const { fixture } = await create();
      for (const value of [
        'editor-only',
        'both-horizontal',
        'both-vertical',
        'tree-only',
      ] as const) {
        fixture.componentRef.setInput('paneLayout', value);
        fixture.detectChanges();
        const checked = (fixture.nativeElement as HTMLElement).querySelector(
          'mat-button-toggle-group.pane-layout-group .mat-button-toggle-checked',
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
        'both-horizontal',
      ] as const) {
        // Mirror what the parent does after each emission so the next
        // click is also a change.
        findSegment(fixture, value).click();
        fixture.componentRef.setInput('paneLayout', value);
        fixture.detectChanges();
      }

      expect(emitted).toEqual(['editor-only', 'both-vertical', 'tree-only', 'both-horizontal']);
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

    describe('M7l narrow viewport collapse', () => {
      const NARROW_THRESHOLD = 768;

      function isNarrow(): boolean {
        return window.innerWidth < NARROW_THRESHOLD;
      }

      function displayOf(fixture: ComponentFixture<ToolbarComponent>, value: string): string {
        const segment = findGroup(fixture).querySelector(
          `mat-button-toggle[value="${value}"]`,
        ) as HTMLElement | null;
        if (!segment) return '';
        return window.getComputedStyle(segment).display;
      }

      it('hides both-horizontal and both-vertical segments at narrow widths', async () => {
        if (!isNarrow()) {
          pending(
            `Karma iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
              'cannot exercise narrow SCSS media query. Skipping.',
          );
          return;
        }
        const { fixture } = await create();
        fixture.componentRef.setInput('paneLayout', 'tree-only');
        fixture.detectChanges();

        expect(displayOf(fixture, 'both-horizontal')).toBe('none');
        expect(displayOf(fixture, 'both-vertical')).toBe('none');
      });

      it('keeps editor-only and tree-only segments visible at narrow widths', async () => {
        if (!isNarrow()) {
          pending(
            `Karma iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
              'cannot exercise narrow SCSS media query. Skipping.',
          );
          return;
        }
        const { fixture } = await create();
        fixture.componentRef.setInput('paneLayout', 'tree-only');
        fixture.detectChanges();

        expect(displayOf(fixture, 'editor-only')).not.toBe('none');
        expect(displayOf(fixture, 'tree-only')).not.toBe('none');
      });

      it('highlights tree-only when paneLayout is tree-only at narrow widths', async () => {
        if (!isNarrow()) {
          pending(
            `Karma iframe width=${window.innerWidth}px is not narrow (< ${NARROW_THRESHOLD}); ` +
              'cannot exercise narrow SCSS media query. Skipping.',
          );
          return;
        }
        const { fixture } = await create();
        fixture.componentRef.setInput('paneLayout', 'tree-only');
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        const checked = (fixture.nativeElement as HTMLElement).querySelector(
          'mat-button-toggle-group.pane-layout-group .mat-button-toggle-checked',
        );
        expect(checked?.getAttribute('value')).toBe('tree-only');
      });
    });
  });

  describe('identity pill states (issue #84)', () => {
    type IdentityPillState = 'draft' | 'saved' | 'modified' | 'saving' | 'signInToSave';

    const pillStateCases: ReadonlyArray<{
      readonly expectedState: IdentityPillState;
      readonly expectedFullText: string;
      readonly signedIn: boolean;
      readonly inputs: ToolbarInputOptions;
    }> = [
      {
        expectedState: 'draft',
        expectedFullText: 'Draft',
        signedIn: false,
        inputs: {
          isSavedBlob: false,
          saveInFlight: false,
        },
      },
      {
        expectedState: 'saving',
        expectedFullText: 'Saving...',
        signedIn: false,
        inputs: {
          isSavedBlob: true,
          isDirty: true,
          saveInFlight: true,
        },
      },
      {
        expectedState: 'signInToSave',
        expectedFullText: 'Sign in to save',
        signedIn: false,
        inputs: {
          isSavedBlob: true,
          saveInFlight: false,
        },
      },
      {
        expectedState: 'modified',
        expectedFullText: 'Modified',
        signedIn: true,
        inputs: {
          isSavedBlob: true,
          isDirty: true,
          saveInFlight: false,
        },
      },
      {
        expectedState: 'saved',
        expectedFullText: 'Saved',
        signedIn: true,
        inputs: {
          isSavedBlob: true,
          isDirty: false,
          saveInFlight: false,
        },
      },
    ];

    for (const pillStateCase of pillStateCases) {
      it(`renders the ${pillStateCase.expectedState} state`, async () => {
        const { fixture } = await create({ signedIn: pillStateCase.signedIn });
        setToolbarInputs(fixture, pillStateCase.inputs);

        const statePill = requireByCss<HTMLElement>(fixture, '.state-pill');
        expect(statePill.classList.contains(`state-pill--${pillStateCase.expectedState}`)).toBe(
          true,
        );
        expect(
          normalizedText(requireByCss<HTMLElement>(fixture, '.state-pill .pill-text-full')),
        ).toBe(pillStateCase.expectedFullText);
        expect(requireByCss<HTMLElement>(fixture, '.state-pill .pill-text-compact')).toBeTruthy();

        const ctaButton = queryByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta');
        if (pillStateCase.expectedState === 'signInToSave') {
          expect(ctaButton).toBeTruthy();
        } else {
          expect(ctaButton).toBeNull();
        }
      });
    }
  });

  describe('signInRequested output (issue #84)', () => {
    it('emits exactly once when the sign-in CTA is clicked', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        saveInFlight: false,
      });
      const signInRequested = vi.fn();
      fixture.componentInstance.signInRequested.subscribe(signInRequested);

      requireByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta').click();
      fixture.detectChanges();

      expect(signInRequested).toHaveBeenCalledTimes(1);
    });

    it('does not emit when the pill is not a CTA', async () => {
      const { fixture } = await create({ signedIn: true });
      const signInRequested = vi.fn();
      fixture.componentInstance.signInRequested.subscribe(signInRequested);
      const nonCtaStates: ReadonlyArray<ToolbarInputOptions> = [
        { isSavedBlob: false, saveInFlight: false },
        { isSavedBlob: true, saveInFlight: true },
        { isSavedBlob: true, isDirty: true, saveInFlight: false },
        { isSavedBlob: true, isDirty: false, saveInFlight: false },
      ];

      for (const nonCtaState of nonCtaStates) {
        setToolbarInputs(fixture, nonCtaState);
        expect(queryByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta')).toBeNull();
        requireByCss<HTMLElement>(fixture, '.state-pill').click();
        fixture.detectChanges();
      }

      expect(signInRequested).not.toHaveBeenCalled();
    });
  });

  describe('save button identity labels (issue #84)', () => {
    it('labels the owner save button as Save', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        canSave: true,
        isSavedBlob: true,
        isOwner: true,
        saveInFlight: false,
      });

      expect(normalizedText(findSaveButton(fixture))).toBe('Save');
    });

    it('labels a signed-in non-owner loaded-blob save as Save as copy', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        canSave: true,
        isSavedBlob: true,
        isOwner: false,
        saveInFlight: false,
      });

      expect(normalizedText(findSaveButton(fixture))).toBe('Save as copy');
    });

    it('labels a signed-in draft save button as Save', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        canSave: true,
        isSavedBlob: false,
        isOwner: false,
        saveInFlight: false,
      });

      expect(normalizedText(findSaveButton(fixture))).toBe('Save');
    });

    it('disables the save button when canSave is false', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        canSave: false,
        isSavedBlob: false,
        saveInFlight: false,
      });

      expect(findSaveButton(fixture).disabled).toBe(true);
    });

    it('disables the save button when saveInFlight is true', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        canSave: true,
        isSavedBlob: false,
        saveInFlight: true,
      });

      expect(findSaveButton(fixture).disabled).toBe(true);
    });
  });

  describe('identity title rendering (issue #84)', () => {
    it('renders title-display instead of title-input for anonymous saved blobs', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: 'Shared blob',
      });

      expect(queryByCss<HTMLElement>(fixture, '.title-display')).toBeTruthy();
      expect(queryByCss<HTMLInputElement>(fixture, '.title-input')).toBeNull();
    });

    it('shows Untitled with the untitled class for null or empty anonymous titles', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: null,
      });
      let titleDisplay = requireByCss<HTMLElement>(fixture, '.title-display');
      expect(normalizedText(titleDisplay)).toBe('Untitled');
      expect(titleDisplay.classList.contains('untitled')).toBe(true);

      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: '',
      });
      titleDisplay = requireByCss<HTMLElement>(fixture, '.title-display');
      expect(normalizedText(titleDisplay)).toBe('Untitled');
      expect(titleDisplay.classList.contains('untitled')).toBe(true);
    });

    it('shows a non-empty anonymous title without the untitled class', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: 'Published example',
      });

      const titleDisplay = requireByCss<HTMLElement>(fixture, '.title-display');
      expect(normalizedText(titleDisplay)).toBe('Published example');
      expect(titleDisplay.classList.contains('untitled')).toBe(false);
    });

    it('renders title-input for signed-in users and emits titleChange on input', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: 'Server title',
        title: 'Editable title',
      });
      const titleChange = vi.fn();
      fixture.componentInstance.titleChange.subscribe(titleChange);

      expect(queryByCss<HTMLElement>(fixture, '.title-display')).toBeNull();
      const titleInput = requireByCss<HTMLInputElement>(fixture, '.title-input');
      expect(titleInput.value).toBe('Editable title');

      titleInput.value = 'Renamed title';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();

      expect(titleChange).toHaveBeenCalledOnceWith('Renamed title');
    });
  });

  describe('compact identity pill text (issue #84)', () => {
    it('renders full and compact spans for non-CTA states', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        isDirty: false,
        saveInFlight: false,
      });

      expect(queryAllByCss<HTMLElement>(fixture, '.state-pill .pill-text-full').length).toBe(1);
      expect(queryAllByCss<HTMLElement>(fixture, '.state-pill .pill-text-compact').length).toBe(1);
      expect(queryByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta')).toBeNull();
    });

    it('renders full and compact spans inside the CTA button', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        saveInFlight: false,
      });

      const ctaButton = requireByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta');
      expect(ctaButton.querySelector('.pill-text-full')).toBeTruthy();
      expect(ctaButton.querySelector('.pill-text-compact')).toBeTruthy();
    });
  });

  describe('identity pill ARIA (issue #84)', () => {
    it('marks the state pill as a polite status region', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: false,
        saveInFlight: false,
      });

      const statePill = requireByCss<HTMLElement>(fixture, '.state-pill');
      expect(statePill.getAttribute('role')).toBe('status');
      expect(statePill.getAttribute('aria-live')).toBe('polite');
    });

    it('gives the sign-in CTA an aria-label', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        saveInFlight: false,
      });

      expect(
        requireByCss<HTMLButtonElement>(fixture, '.state-pill button.pill-cta').getAttribute(
          'aria-label',
        ),
      ).toBe('Sign in to save and share');
    });
  });

  describe('identity-control child order', () => {
    function classOfChild(parent: Element, index: number): string {
      const child = parent.children.item(index);
      if (!child) {
        throw new Error(`expected child at index ${index} of identity-control`);
      }
      return child.className;
    }

    it('signed-in: renders [title-input, wand, suggestionsMenu, state-pill, save-button] in order', async () => {
      const { fixture } = await create({ signedIn: true });
      setToolbarInputs(fixture, {
        isSavedBlob: false,
        isDirty: false,
        saveInFlight: false,
      });

      const identityControl = requireByCss<HTMLElement>(fixture, '.identity-control');
      expect(identityControl.children.length).toBe(5);
      expect(classOfChild(identityControl, 0)).toContain('title-input');
      expect(classOfChild(identityControl, 1)).toContain('title-suggest-wand');
      expect(identityControl.children.item(2)?.tagName.toLowerCase()).toBe('mat-menu');
      expect(classOfChild(identityControl, 3)).toContain('state-pill');
      expect(classOfChild(identityControl, 4)).toContain('save-button');
    });

    it('anonymous on saved blob: renders [title-display, state-pill (with CTA)] in order', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: 'Shared blob',
        saveInFlight: false,
      });

      const identityControl = requireByCss<HTMLElement>(fixture, '.identity-control');
      expect(identityControl.children.length).toBe(2);
      expect(classOfChild(identityControl, 0)).toContain('title-display');
      expect(classOfChild(identityControl, 1)).toContain('state-pill');
      expect(identityControl.querySelector('.state-pill button.pill-cta')).toBeTruthy();
      expect(identityControl.querySelector('.save-button')).toBeNull();
    });

    it('anonymous, no saved blob: state-pill is the only child; no title or save-button', async () => {
      const { fixture } = await create();
      setToolbarInputs(fixture, {
        isSavedBlob: false,
        saveInFlight: false,
      });

      const identityControl = requireByCss<HTMLElement>(fixture, '.identity-control');
      expect(identityControl.children.length).toBe(1);
      expect(classOfChild(identityControl, 0)).toContain('state-pill');
      expect(identityControl.querySelector('.title-display')).toBeNull();
      expect(identityControl.querySelector('.title-input')).toBeNull();
      expect(identityControl.querySelector('.save-button')).toBeNull();
    });
  });

  describe('file input wiring', () => {
    it('emits upload when onFileChange receives a file', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const file = new File(['{"a":1}'], 'x.json', { type: 'application/json' });
      const input = document.createElement('input');
      input.type = 'file';
      const spy = vi.fn();
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
      const spy = vi.fn();
      cmp.upload.subscribe(spy);
      cmp.onFileChange({ target: input } as unknown as Event);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('toolbar.action telemetry', () => {
    const toolbarActions: ToolbarAction[] = [
      'paste',
      'copy',
      'copyEscaped',
      'openFile',
      'fileChange',
      'download',
      'format',
      'minify',
      'sort',
      'clear',
      'save',
      'copyShareLink',
      'togglePublic',
      'deleteBlob',
    ];

    function configureActionFixture(fixture: ComponentFixture<ToolbarComponent>): void {
      fixture.componentRef.setInput('hasContent', true);
      fixture.componentRef.setInput('canSave', true);
      fixture.componentRef.setInput('saveInFlight', false);
      fixture.componentRef.setInput('isOwner', true);
      fixture.componentRef.setInput('isPublic', false);
      fixture.detectChanges();
    }

    function hostElement(fixture: ComponentFixture<ToolbarComponent>): HTMLElement {
      return fixture.nativeElement as HTMLElement;
    }

    function findButtonByAriaLabel(
      fixture: ComponentFixture<ToolbarComponent>,
      ariaLabel: string,
    ): HTMLButtonElement {
      const button = Array.from(
        hostElement(fixture).querySelectorAll<HTMLButtonElement>('button'),
      ).find((candidateButton) => candidateButton.getAttribute('aria-label') === ariaLabel);
      if (!button) {
        throw new Error(`button with aria-label "${ariaLabel}" not found`);
      }
      return button;
    }

    function findFileInput(fixture: ComponentFixture<ToolbarComponent>): HTMLInputElement {
      const fileInput = hostElement(fixture).querySelector<HTMLInputElement>('input[type="file"]');
      if (!fileInput) {
        throw new Error('hidden file input not found');
      }
      return fileInput;
    }

    function findToggleSegment(
      fixture: ComponentFixture<ToolbarComponent>,
      groupSelector: string,
      value: string,
    ): HTMLButtonElement {
      const segment = hostElement(fixture).querySelector<HTMLButtonElement>(
        `${groupSelector} mat-button-toggle[value="${value}"] button`,
      );
      if (!segment) {
        throw new Error(`toggle segment "${value}" not found`);
      }
      return segment;
    }

    function makeFile(): File {
      return new File(['{"a":1}'], 'x.json', { type: 'application/json' });
    }

    function triggerPasteButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Paste JSON from clipboard').click();
      fixture.detectChanges();
    }

    function triggerCopyButtonClick(
      fixture: ComponentFixture<ToolbarComponent>,
      options: { readonly altKey: boolean },
    ): void {
      findButtonByAriaLabel(fixture, 'Copy editor contents to clipboard').dispatchEvent(
        new MouseEvent('click', {
          altKey: options.altKey,
          bubbles: true,
        }),
      );
      fixture.detectChanges();
    }

    function triggerUploadButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Upload file').click();
      fixture.detectChanges();
    }

    function triggerFileInputChangeWithFile(
      fixture: ComponentFixture<ToolbarComponent>,
      file: File,
    ): void {
      const fileInput = findFileInput(fixture);
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [file],
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
    }

    function triggerFileInputChangeWithoutFile(fixture: ComponentFixture<ToolbarComponent>): void {
      const fileInput = findFileInput(fixture);
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [],
      });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fixture.detectChanges();
    }

    function triggerDownloadButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Download as file').click();
      fixture.detectChanges();
    }

    function triggerFormatButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Format').click();
      fixture.detectChanges();
    }

    function triggerMinifyButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Minify').click();
      fixture.detectChanges();
    }

    function triggerSortButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Sort keys').click();
      fixture.detectChanges();
    }

    function triggerClearButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Clear editor').click();
      fixture.detectChanges();
    }

    function triggerSaveButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findSaveButton(fixture).click();
      fixture.detectChanges();
    }

    function triggerTitleEnterKeydown(fixture: ComponentFixture<ToolbarComponent>): void {
      const titleInput = hostElement(fixture).querySelector<HTMLInputElement>('input.title-field');
      if (!titleInput) {
        throw new Error('title input not found');
      }
      titleInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          key: 'Enter',
        }),
      );
      fixture.detectChanges();
    }

    function triggerMenuItemClick(
      fixture: ComponentFixture<ToolbarComponent>,
      menuItemText: string,
    ): void {
      findButtonByAriaLabel(fixture, 'More actions for this blob').click();
      fixture.detectChanges();
      const menuItem = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('.cdk-overlay-container button'),
      ).find((candidateButton) => candidateButton.textContent?.includes(menuItemText));
      if (!menuItem) {
        throw new Error(`menu item "${menuItemText}" not found`);
      }
      menuItem.click();
      fixture.detectChanges();
    }

    function triggerCopyShareLinkMenuClick(fixture: ComponentFixture<ToolbarComponent>): void {
      triggerMenuItemClick(fixture, 'Copy share link');
    }

    function triggerTogglePublicMenuClick(fixture: ComponentFixture<ToolbarComponent>): void {
      triggerMenuItemClick(fixture, 'Make public');
    }

    function triggerDeleteBlobMenuClick(fixture: ComponentFixture<ToolbarComponent>): void {
      triggerMenuItemClick(fixture, 'Delete this blob');
    }

    function triggerThemeToggleButtonClick(fixture: ComponentFixture<ToolbarComponent>): void {
      // Aria-label is dynamic per theme state (M7f-2). Match any of the
      // three valid values rather than the static legacy "Toggle theme".
      const themeLabels = new Set([
        'Switch to light theme',
        'Switch to dark theme',
        'Match system theme',
      ]);
      const button = Array.from(
        hostElement(fixture).querySelectorAll<HTMLButtonElement>('button'),
      ).find((candidateButton) =>
        themeLabels.has(candidateButton.getAttribute('aria-label') ?? ''),
      );
      if (!button) {
        throw new Error('theme toggle button not found');
      }
      button.click();
      fixture.detectChanges();
    }

    function triggerSelectionSyncToggleClick(fixture: ComponentFixture<ToolbarComponent>): void {
      findButtonByAriaLabel(fixture, 'Toggle tree-editor selection sync').click();
      fixture.detectChanges();
    }

    function triggerPaneLayoutSegmentChange(fixture: ComponentFixture<ToolbarComponent>): void {
      findToggleSegment(fixture, 'mat-button-toggle-group.pane-layout-group', 'tree-only').click();
      fixture.detectChanges();
    }

    function makeToolbarActionCases(
      fixture: ComponentFixture<ToolbarComponent>,
    ): Array<[ToolbarAction, () => void]> {
      return [
        ['paste', () => triggerPasteButtonClick(fixture)],
        ['copy', () => triggerCopyButtonClick(fixture, { altKey: false })],
        ['copyEscaped', () => triggerCopyButtonClick(fixture, { altKey: true })],
        ['openFile', () => triggerUploadButtonClick(fixture)],
        ['fileChange', () => triggerFileInputChangeWithFile(fixture, makeFile())],
        ['download', () => triggerDownloadButtonClick(fixture)],
        ['format', () => triggerFormatButtonClick(fixture)],
        ['minify', () => triggerMinifyButtonClick(fixture)],
        ['sort', () => triggerSortButtonClick(fixture)],
        ['clear', () => triggerClearButtonClick(fixture)],
        ['save', () => triggerSaveButtonClick(fixture)],
        ['copyShareLink', () => triggerCopyShareLinkMenuClick(fixture)],
        ['togglePublic', () => triggerTogglePublicMenuClick(fixture)],
        ['deleteBlob', () => triggerDeleteBlobMenuClick(fixture)],
      ];
    }

    function findTriggerGesture(
      cases: Array<[ToolbarAction, () => void]>,
      expectedAction: ToolbarAction,
    ): () => void {
      const toolbarActionCase = cases.find(([action]) => action === expectedAction);
      if (!toolbarActionCase) {
        throw new Error(`toolbar.action case "${expectedAction}" not found`);
      }
      return toolbarActionCase[1];
    }

    function trackActionOutput(
      fixture: ComponentFixture<ToolbarComponent>,
      action: ToolbarAction,
      orderedCalls: string[],
    ): MockInstance {
      if (action === 'openFile') {
        return vi.spyOn(findFileInput(fixture), 'click').mockImplementation(() => {
          orderedCalls.push('output');
        });
      }

      const outputSpy = jasmine.createSpy(`${action} output`).mockImplementation(() => {
        orderedCalls.push('output');
      });
      const component = fixture.componentInstance;
      switch (action) {
        case 'paste':
          component.pasteRequested.subscribe(() => outputSpy());
          break;
        case 'copy':
          component.copyRequested.subscribe(() => outputSpy());
          break;
        case 'copyEscaped':
          component.copyEscaped.subscribe(() => outputSpy());
          break;
        case 'fileChange':
          component.upload.subscribe(() => outputSpy());
          break;
        case 'download':
          component.download.subscribe(() => outputSpy());
          break;
        case 'format':
          component.format.subscribe(() => outputSpy());
          break;
        case 'minify':
          component.minify.subscribe(() => outputSpy());
          break;
        case 'sort':
          component.sort.subscribe(() => outputSpy());
          break;
        case 'clear':
          component.clear.subscribe(() => outputSpy());
          break;
        case 'save':
          component.save.subscribe(() => outputSpy());
          break;
        case 'copyShareLink':
          component.copyShareLink.subscribe(() => outputSpy());
          break;
        case 'togglePublic':
          component.togglePublic.subscribe(() => outputSpy());
          break;
        case 'deleteBlob':
          component.deleteBlob.subscribe(() => outputSpy());
          break;
      }
      return outputSpy;
    }

    function expectNoToolbarActionEvent(logger: Mocked<LoggerService>): void {
      const toolbarActionCalls = logger.event.calls
        .allArgs()
        .filter(([messageId]) => messageId === 'toolbar.action');
      expect(toolbarActionCalls).toEqual([]);
    }

    for (const expectedAction of toolbarActions) {
      it(`emits toolbar.action ${expectedAction} before the gesture output`, async () => {
        const { fixture, logger } = await create({ signedIn: true });
        configureActionFixture(fixture);
        const orderedCalls: string[] = [];
        const outputSpy = trackActionOutput(fixture, expectedAction, orderedCalls);
        logger.event.mockClear();
        logger.event.mockImplementation(() => {
          orderedCalls.push('event');
        });

        findTriggerGesture(makeToolbarActionCases(fixture), expectedAction)();

        expect(logger.event).toHaveBeenCalledOnceWith(
          'toolbar.action',
          { action: expectedAction },
          undefined,
        );
        expect(outputSpy).toHaveBeenCalledTimes(1);
        expect(orderedCalls).toEqual(['event', 'output']);
      });
    }

    it('onSortClick emits the sort output', async () => {
      const { fixture } = await create();
      const sortSpy = vi.fn();
      fixture.componentInstance.sort.subscribe(sortSpy);

      fixture.componentInstance.onSortClick();

      expect(sortSpy).toHaveBeenCalledTimes(1);
    });

    it('clicking the Sort keys button calls onSortClick', async () => {
      const { fixture } = await create();
      configureActionFixture(fixture);
      const onSortClickSpy = vi.spyOn(fixture.componentInstance, 'onSortClick');

      triggerSortButtonClick(fixture);

      expect(onSortClickSpy).toHaveBeenCalledTimes(1);
    });

    it('Sort keys button is disabled when empty and enabled when content exists', async () => {
      const { fixture } = await create();

      fixture.componentRef.setInput('hasContent', false);
      fixture.detectChanges();
      expect(findButtonByAriaLabel(fixture, 'Sort keys').disabled).toBe(true);

      fixture.componentRef.setInput('hasContent', true);
      fixture.detectChanges();
      expect(findButtonByAriaLabel(fixture, 'Sort keys').disabled).toBe(false);
    });

    it('emits toolbar.action save before save when Enter is pressed in the title field', async () => {
      const { fixture, logger } = await create({ signedIn: true });
      configureActionFixture(fixture);
      const orderedCalls: string[] = [];
      const outputSpy = trackActionOutput(fixture, 'save', orderedCalls);
      logger.event.mockClear();
      logger.event.mockImplementation(() => {
        orderedCalls.push('event');
      });

      triggerTitleEnterKeydown(fixture);

      expect(logger.event).toHaveBeenCalledOnceWith(
        'toolbar.action',
        { action: 'save' },
        undefined,
      );
      expect(outputSpy).toHaveBeenCalledTimes(1);
      expect(orderedCalls).toEqual(['event', 'output']);
    });

    it('does not emit fileChange telemetry when file selection is canceled', async () => {
      const { fixture, logger } = await create();
      configureActionFixture(fixture);
      logger.event.mockClear();

      triggerFileInputChangeWithoutFile(fixture);

      expectNoToolbarActionEvent(logger);
    });

    it('does not emit toolbar.action for theme toggle clicks', async () => {
      const { fixture, logger } = await create();
      configureActionFixture(fixture);
      logger.event.mockClear();

      triggerThemeToggleButtonClick(fixture);

      expectNoToolbarActionEvent(logger);
    });

    it('does not emit toolbar.action for selection-sync toggle clicks', async () => {
      const { fixture, logger } = await create();
      configureActionFixture(fixture);
      logger.event.mockClear();

      triggerSelectionSyncToggleClick(fixture);

      expectNoToolbarActionEvent(logger);
    });

    it('does not emit toolbar.action for pane layout segment changes', async () => {
      const { fixture, logger } = await create();
      configureActionFixture(fixture);
      logger.event.mockClear();

      triggerPaneLayoutSegmentChange(fixture);

      expectNoToolbarActionEvent(logger);
    });
  });

  it('copyRequested output fires when button click is translated (direct emit path)', async () => {
    const { fixture } = await create();
    const cmp = fixture.componentInstance;
    const spy = vi.fn();
    cmp.copyRequested.subscribe(spy);
    cmp.copyRequested.emit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('onCopyClick', () => {
    it('emits copyRequested on a plain click', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const copy = vi.fn();
      const copyEscaped = vi.fn();
      cmp.copyRequested.subscribe(copy);
      cmp.copyEscaped.subscribe(copyEscaped);
      cmp.onCopyClick(new MouseEvent('click', { altKey: false }));
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copyEscaped).not.toHaveBeenCalled();
    });

    it('emits copyEscaped when Alt is held', async () => {
      const { fixture } = await create();
      const cmp = fixture.componentInstance;
      const copy = vi.fn();
      const copyEscaped = vi.fn();
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
      const spy = vi.fn();
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
      const spy = vi.fn();
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
      const spy = vi.fn();
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
      const spy = vi.fn();
      cmp.save.subscribe(spy);
      cmp.onTitleKeydown(new KeyboardEvent('keydown', { key: 'a' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('native paste into the title input does NOT trigger the pasteRequested output (regression)', async () => {
      const { fixture } = await create({ signedIn: true });
      const cmp = fixture.componentInstance;
      const pasteSpy = vi.fn();
      const copySpy = vi.fn();
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
      const copy = vi.fn();
      const toggle = vi.fn();
      const del = vi.fn();
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
      const btn = (fixture.nativeElement as HTMLElement).querySelector('button.paste-ready');
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
      const btn = (fixture.nativeElement as HTMLElement).querySelector('button.paste-ready');
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
      const spy = vi.fn();
      cmp.pasteRequested.subscribe(spy);
      cmp.pasteRequested.emit();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('M7p title-suggester wand', () => {
    function findWandButton(fixture: ComponentFixture<ToolbarComponent>): HTMLButtonElement | null {
      return queryByCss<HTMLButtonElement>(fixture, '.title-suggest-wand');
    }

    it('renders the wand button when signed in', async () => {
      const { fixture } = await create({ signedIn: true });
      expect(findWandButton(fixture)).not.toBeNull();
    });

    it('does not render the wand for an anonymous viewer of a saved blob', async () => {
      // Anonymous-on-saved-blob renders a span title-display, not the
      // input branch where the wand lives.
      const { fixture } = await create({ signedIn: false });
      setToolbarInputs(fixture, {
        isSavedBlob: true,
        loadedBlobTitle: 'My Blob',
      });
      expect(findWandButton(fixture)).toBeNull();
    });

    it('is disabled when wandEnabled is false', async () => {
      const { fixture } = await create({ signedIn: true });
      fixture.componentRef.setInput('wandEnabled', false);
      fixture.detectChanges();
      expect(findWandButton(fixture)?.disabled).toBe(true);
    });

    it('is enabled when wandEnabled is true', async () => {
      const { fixture } = await create({ signedIn: true });
      fixture.componentRef.setInput('wandEnabled', true);
      fixture.detectChanges();
      expect(findWandButton(fixture)?.disabled).toBe(false);
    });

    it('emits suggestRequested on click', async () => {
      const { fixture } = await create({ signedIn: true });
      fixture.componentRef.setInput('wandEnabled', true);
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      const spy = vi.fn();
      cmp.suggestRequested.subscribe(spy);
      findWandButton(fixture)?.click();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT call any suggestion code on plain user typing', async () => {
      // Lazy-on-click: typing in the editor should not run the
      // suggester. We assert this by spying on the suggestRequested
      // output emitter -- it should never fire just by the wand
      // button being present.
      const { fixture } = await create({ signedIn: true });
      const cmp = fixture.componentInstance;
      const spy = vi.fn();
      cmp.suggestRequested.subscribe(spy);
      // Simulate the parent updating inputs (as it would on every
      // keystroke for hasContent / wandEnabled).
      fixture.componentRef.setInput('wandEnabled', true);
      fixture.componentRef.setInput('hasContent', true);
      fixture.detectChanges();
      fixture.componentRef.setInput('wandEnabled', false);
      fixture.detectChanges();
      expect(spy).not.toHaveBeenCalled();
    });

    it('calls onSuggestionSelected with the candidate and emits titleChange', async () => {
      const { fixture, logger } = await create({ signedIn: true });
      const cmp = fixture.componentInstance;
      const spy = vi.fn();
      cmp.titleChange.subscribe(spy);
      cmp.onSuggestionSelected({
        value: 'My Title',
        source: 'namedField',
        confidence: 75,
      });
      expect(spy).toHaveBeenCalledWith('My Title');
      expect(logger.event).toHaveBeenCalledWith(
        'toolbar.titleSuggestionAccepted',
        { source: 'namedField' },
        { candidateCount: 0 },
      );
    });

    it('reports the menu candidate count on selection telemetry', async () => {
      const { fixture, logger } = await create({ signedIn: true });
      fixture.componentRef.setInput('suggestedTitles', [
        { value: 'A', source: 'filename', confidence: 95 },
        { value: 'B', source: 'namedField', confidence: 75 },
        { value: 'C', source: 'firstChars', confidence: 10 },
      ]);
      fixture.detectChanges();
      const cmp = fixture.componentInstance;
      cmp.onSuggestionSelected({
        value: 'A',
        source: 'filename',
        confidence: 95,
      });
      expect(logger.event).toHaveBeenCalledWith(
        'toolbar.titleSuggestionAccepted',
        { source: 'filename' },
        { candidateCount: 3 },
      );
    });
  });
});
