import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { provideFakeAuth } from '../../../../../testing/auth.testing';
import { PreferencesService } from '../../../../core/preferences/preferences.service';
import {
  HIGHLIGHT_PALETTE_DARK,
  HIGHLIGHT_PALETTE_LIGHT,
  contrastText,
} from '../highlight-palette';
import {
  HighlightFlyoutComponent,
  type HighlightFlyoutApplyEvent,
} from './highlight-flyout.component';

const STORAGE_KEY = 'jotjson.preferences.v1';

describe('HighlightFlyoutComponent', () => {
  let fixture: ComponentFixture<HighlightFlyoutComponent>;
  let cmp: HighlightFlyoutComponent;
  let prefs: PreferencesService;
  let applyEvents: HighlightFlyoutApplyEvent[];
  let closeEvents: number;

  async function createComponent(theme: 'light' | 'dark' = 'light'): Promise<void> {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HighlightFlyoutComponent],
      providers: [...provideFakeAuth(), provideNoopAnimations()],
    }).compileComponents();

    prefs = TestBed.inject(PreferencesService);
    prefs.update({ theme });

    fixture = TestBed.createComponent(HighlightFlyoutComponent);
    cmp = fixture.componentInstance;
    applyEvents = [];
    closeEvents = 0;
    cmp.apply.subscribe((event) => applyEvents.push(event));
    cmp.close.subscribe(() => (closeEvents += 1));
    // Attach to DOM so `.focus()` actually moves `document.activeElement`.
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  }

  afterEach(() => {
    if (fixture?.nativeElement?.parentElement === document.body) {
      document.body.removeChild(fixture.nativeElement);
    }
  });

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function preferredBar(): HTMLButtonElement {
    return host().querySelector<HTMLButtonElement>('.preferred-bar')!;
  }

  function swatches(): HTMLButtonElement[] {
    return Array.from(host().querySelectorAll<HTMLButtonElement>('.swatch'));
  }

  function dispatchKey(key: string): void {
    const target =
      (document.activeElement instanceof HTMLElement ? document.activeElement : preferredBar()) ??
      preferredBar();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }

  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  describe('initial render', () => {
    it('puts tabindex=0 on the Preferred bar and tabindex=-1 on every swatch', async () => {
      await createComponent('light');

      expect(preferredBar().getAttribute('tabindex')).toBe('0');
      const tabs = swatches().map((s) => s.getAttribute('tabindex'));
      expect(tabs).toEqual(new Array(HIGHLIGHT_PALETTE_LIGHT.length).fill('-1'));
    });

    it('renders the swatches in two role=row containers under a role=grid', async () => {
      await createComponent('light');

      const grid = host().querySelector<HTMLElement>('.swatch-grid');
      expect(grid?.getAttribute('role')).toBe('grid');
      const rows = grid?.querySelectorAll<HTMLElement>('[role="row"]') ?? [];
      expect(rows.length).toBe(2);
      const cells = grid?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? [];
      expect(cells.length).toBe(HIGHLIGHT_PALETTE_LIGHT.length);
    });

    it('labels every swatch with its name and hex from the active palette', async () => {
      await createComponent('light');

      const labels = swatches().map((s) => s.getAttribute('aria-label'));
      expect(labels).toEqual(HIGHLIGHT_PALETTE_LIGHT.map((s) => `${s.name} ${s.hex}`));
    });

    it('paints the Preferred bar in the preferred color with contrast text', async () => {
      await createComponent('light');
      const expected = contrastText(
        prefs.prefs().treeHighlightColors[prefs.effectiveTheme()].manualHighlightColor,
      );
      const color = preferredBar().style.color.replace(/\s/g, '').toLowerCase();
      // Browsers normalize hex to rgb(); accept either form for the
      // two contrast endpoints.
      const normalized =
        color === 'rgb(0,0,0)' || color === '#000000'
          ? '#000000'
          : color === 'rgb(255,255,255)' || color === '#ffffff'
            ? '#ffffff'
            : color;
      expect(normalized).toBe(expected);
    });

    it('swaps palettes when the theme flips to dark', async () => {
      await createComponent('light');
      prefs.update({ theme: 'dark' });
      fixture.detectChanges();

      const labels = swatches().map((s) => s.getAttribute('aria-label'));
      expect(labels).toEqual(HIGHLIGHT_PALETTE_DARK.map((s) => `${s.name} ${s.hex}`));
    });
  });

  describe('focusEntry', () => {
    it('focuses the Preferred bar after a microtask flush', async () => {
      await createComponent('light');

      cmp.focusEntry();
      await flushMicrotasks();

      expect(document.activeElement).toBe(preferredBar());
    });

    it('flips the kbd-focused class onto the active cell', async () => {
      await createComponent('light');

      cmp.focusEntry();
      await flushMicrotasks();

      expect(preferredBar().classList.contains('kbd-focused')).toBeTrue();
    });
  });

  describe('keyboard navigation', () => {
    async function openAndFocus(): Promise<void> {
      await createComponent('light');
      cmp.focusEntry();
      await flushMicrotasks();
    }

    it('ArrowDown from Preferred moves to swatch row 1, column 0', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();

      const list = swatches();
      expect(document.activeElement).toBe(list[0]!);
      expect(list[0]!.getAttribute('tabindex')).toBe('0');
      expect(preferredBar().getAttribute('tabindex')).toBe('-1');
    });

    it('ArrowDown from row 1 preserves the column when moving to row 2', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      dispatchKey('ArrowRight');
      await flushMicrotasks();
      dispatchKey('ArrowRight');
      await flushMicrotasks();
      // Now at swatch col 2 row 0 (the third swatch).
      dispatchKey('ArrowDown');
      await flushMicrotasks();

      const list = swatches();
      // Row 2 col 2 == flat index 7 (5 + 2).
      expect(document.activeElement).toBe(list[7]!);
    });

    it('ArrowDown from row 2 is a no-op (no wrap)', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      // Active is now row 2 col 0 (flat index 5).
      const list = swatches();
      expect(document.activeElement).toBe(list[5]!);
      dispatchKey('ArrowDown');
      await flushMicrotasks();

      expect(document.activeElement).toBe(list[5]!);
    });

    it('ArrowUp from Preferred is a no-op (no wrap)', async () => {
      await openAndFocus();
      dispatchKey('ArrowUp');
      await flushMicrotasks();

      expect(document.activeElement).toBe(preferredBar());
    });

    it('ArrowUp from row 1 returns to Preferred', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      dispatchKey('ArrowUp');
      await flushMicrotasks();

      expect(document.activeElement).toBe(preferredBar());
    });

    it('ArrowLeft / ArrowRight on Preferred are no-ops', async () => {
      await openAndFocus();
      dispatchKey('ArrowLeft');
      await flushMicrotasks();
      expect(document.activeElement).toBe(preferredBar());
      dispatchKey('ArrowRight');
      await flushMicrotasks();
      expect(document.activeElement).toBe(preferredBar());
    });

    it('ArrowLeft clamps at column 0', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      // At swatch col 0 row 0.
      const list = swatches();
      dispatchKey('ArrowLeft');
      await flushMicrotasks();
      expect(document.activeElement).toBe(list[0]!);
    });

    it('ArrowRight clamps at column 4', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      for (let i = 0; i < 6; i++) {
        dispatchKey('ArrowRight');
        await flushMicrotasks();
      }
      const list = swatches();
      // Should be at row 0 col 4 (flat index 4), not past.
      expect(document.activeElement).toBe(list[4]!);
    });

    it('Enter on a swatch emits apply with inputMode=keyboard', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      dispatchKey('Enter');
      await flushMicrotasks();

      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe(HIGHLIGHT_PALETTE_LIGHT[0]!.hex);
      expect(applyEvents[0]!.inputMode).toBe('keyboard');
    });

    it('Space on a swatch emits apply with inputMode=keyboard', async () => {
      await openAndFocus();
      dispatchKey('ArrowDown');
      await flushMicrotasks();
      dispatchKey(' ');
      await flushMicrotasks();

      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe(HIGHLIGHT_PALETTE_LIGHT[0]!.hex);
      expect(applyEvents[0]!.inputMode).toBe('keyboard');
    });

    it('Enter on Preferred emits apply with the preferred color and inputMode=keyboard', async () => {
      await openAndFocus();
      prefs.update({
        treeHighlightColors: {
          ...prefs.prefs().treeHighlightColors,
          light: {
            ...prefs.prefs().treeHighlightColors.light,
            manualHighlightColor: '#abcdef',
          },
        },
      });
      fixture.detectChanges();
      dispatchKey('Enter');
      await flushMicrotasks();

      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe('#abcdef');
      expect(applyEvents[0]!.inputMode).toBe('keyboard');
    });

    it('Tab emits close (not apply)', async () => {
      await openAndFocus();
      dispatchKey('Tab');
      await flushMicrotasks();

      expect(applyEvents.length).toBe(0);
      expect(closeEvents).toBe(1);
    });

    it('Escape does not emit close (passes through to mat-menu)', async () => {
      await openAndFocus();
      dispatchKey('Escape');
      await flushMicrotasks();

      expect(closeEvents).toBe(0);
    });
  });

  describe('mouse + keyboard handoff', () => {
    it('mouseenter on swatch 5 then ArrowRight + Enter emits swatch 6', async () => {
      await createComponent('light');
      cmp.focusEntry();
      await flushMicrotasks();

      const list = swatches();
      // mouseenter on the 5th swatch (row 1 col 4).
      list[4]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      fixture.detectChanges();
      // Without sync, ArrowRight from Preferred would be a no-op.
      // After sync, activeIndex points at swatch 5 (flat index 4),
      // so ArrowRight clamps at col 4 -> no-op. Use a different
      // anchor: mouseenter on swatch 6 (flat index 5, row 2 col 0).
      list[5]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      fixture.detectChanges();
      dispatchKey('ArrowRight');
      await flushMicrotasks();
      dispatchKey('Enter');
      await flushMicrotasks();

      // swatch 5 (flat index 5, row 2 col 0) -> ArrowRight -> flat 6
      // (row 2 col 1) -> Enter emits palette[6].
      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe(HIGHLIGHT_PALETTE_LIGHT[6]!.hex);
      expect(applyEvents[0]!.inputMode).toBe('keyboard');
    });
  });

  describe('mouse click', () => {
    it('clicking a swatch emits apply with inputMode=mouse', async () => {
      await createComponent('light');
      const list = swatches();
      list[2]!.click();
      fixture.detectChanges();

      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe(HIGHLIGHT_PALETTE_LIGHT[2]!.hex);
      expect(applyEvents[0]!.inputMode).toBe('mouse');
    });

    it('clicking the Preferred bar emits apply with the preferred color and inputMode=mouse', async () => {
      await createComponent('light');
      prefs.update({
        treeHighlightColors: {
          ...prefs.prefs().treeHighlightColors,
          light: {
            ...prefs.prefs().treeHighlightColors.light,
            manualHighlightColor: '#123456',
          },
        },
      });
      fixture.detectChanges();
      preferredBar().click();
      fixture.detectChanges();

      expect(applyEvents.length).toBe(1);
      expect(applyEvents[0]!.color).toBe('#123456');
      expect(applyEvents[0]!.inputMode).toBe('mouse');
    });

    it('clicking the flyout padding (root) does not emit apply (stopPropagation guard)', async () => {
      await createComponent('light');
      const root = host().querySelector<HTMLElement>('.highlight-flyout')!;
      root.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fixture.detectChanges();

      expect(applyEvents.length).toBe(0);
    });
  });

  describe('focus ring modality', () => {
    it('keeps kbd-focused only on the active cell, not idle cells', async () => {
      await createComponent('light');
      cmp.focusEntry();
      await flushMicrotasks();
      dispatchKey('ArrowDown');
      await flushMicrotasks();

      const list = swatches();
      expect(list[0]!.classList.contains('kbd-focused')).toBeTrue();
      expect(preferredBar().classList.contains('kbd-focused')).toBeFalse();
      expect(list[1]!.classList.contains('kbd-focused')).toBeFalse();
    });

    it('drops kbd-focused after a mouse hover (interactionMode flips to mouse)', async () => {
      await createComponent('light');
      cmp.focusEntry();
      await flushMicrotasks();

      expect(preferredBar().classList.contains('kbd-focused')).toBeTrue();
      const list = swatches();
      list[3]!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      fixture.detectChanges();

      expect(list[3]!.classList.contains('kbd-focused')).toBeFalse();
      expect(preferredBar().classList.contains('kbd-focused')).toBeFalse();
    });
  });
});
