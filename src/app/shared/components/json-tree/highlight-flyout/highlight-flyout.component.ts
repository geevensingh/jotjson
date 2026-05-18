import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';

import { PreferencesService } from '../../../../core/preferences/preferences.service';
import {
  HIGHLIGHT_PALETTE_DARK,
  HIGHLIGHT_PALETTE_LIGHT,
  type PaletteSwatch,
  contrastText,
} from '../highlight-palette';

/**
 * Payload emitted by `HighlightFlyoutComponent.apply`. The `inputMode`
 * field captures whether the swatch was activated via keyboard (Enter
 * / Space inside the flyout) or via a mouse click, so the parent tree
 * can forward it to the `tree.highlight.apply` telemetry event.
 */
export interface HighlightFlyoutApplyEvent {
  readonly color: string;
  readonly inputMode: 'keyboard' | 'mouse';
}

/**
 * Per-node manual-highlight color picker, rendered inside the row's
 * `<mat-menu>` panel. Issue #100 (a11y: keyboard navigation).
 *
 * Design rationale:
 *
 * - **Keydown is bound at the component host with `{ capture: true }`**
 *   so the arrow keys / Enter / Space are intercepted before
 *   `MatMenu`'s overlay-level `keydownEvents()` subscription gets a
 *   chance to run its own focus-shifting logic. Descendant
 *   `stopPropagation()` alone does not stop the overlay because the
 *   overlay subscribes via `Overlay.keydownEvents()` rather than the
 *   bubble path.
 *
 * - **Escape is intentionally not handled.** Letting Escape bubble
 *   into the `MatMenu` panel listener gives free flyout-closes-and-
 *   focus-returns-to-parent-menu-item behavior, matching every other
 *   submenu in the app. Handling it here would duplicate Material's
 *   focus-return logic and risk drift.
 *
 * - **Tab is handled explicitly as "close + parent restores row
 *   focus".** It is not a no-op because Tab inside an open `MatMenu`
 *   does not naturally close the panel; without explicit handling the
 *   tab order escapes into the page behind the overlay, which is a
 *   worse UX than closing.
 *
 * - **Visible focus ring uses an `interactionMode` signal** rather
 *   than `:focus-visible` alone. After a mouse-open path, calling
 *   `.focus()` programmatically silently fails the
 *   `:focus-visible` heuristic in Chromium/Firefox, breaking the
 *   "every keyboard step has a visible ring" acceptance criterion.
 *   The signal flips to `'keyboard'` on any of the supported keys and
 *   back to `'mouse'` on mouseenter / mousedown, and the active cell
 *   binds `[class.kbd-focused]="interactionMode() === 'keyboard'"` to
 *   force the ring during keyboard navigation regardless of how the
 *   panel was opened.
 *
 * - **The flyout injects `PreferencesService` rather than receiving
 *   the palette / preferred color / contrast text via inputs.** The
 *   parent tree already knows the preferred color (it still applies
 *   it on the parent menu-item Enter path); duplicating those
 *   derivations across the boundary would turn the flyout into a
 *   relay station with five identical inputs.
 *
 * - **No `LoggerService` injection.** Telemetry stays in the parent
 *   tree; this component just emits a typed `apply` event with the
 *   captured input mode. Keeps the component dependency-light and
 *   avoids a second emit site for the `tree.highlight.apply` event.
 *
 * - **`role="grid"` with `role="row"` + `role="gridcell"`** on the
 *   2x5 swatch area gives screen readers positional context ("row 1
 *   of 2, column 3 of 5") during keyboard navigation. The Preferred
 *   bar sits above the grid as a single button (not part of the
 *   grid) and is announced via its own `aria-label`.
 */
@Component({
  selector: 'jj-highlight-flyout',
  standalone: true,
  imports: [MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './highlight-flyout.component.html',
  styleUrls: ['./highlight-flyout.component.scss'],
})
export class HighlightFlyoutComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly cdr = inject(ChangeDetectorRef);

  /**
   * `true` when this flyout instance is mounted under a cascade-scope
   * mat-menu (`#highlightTreeMenu`), `false` for single-row scope
   * (`#highlightMenu`). The flyout itself does not branch on this
   * value (apply behavior is identical); it is exposed so a future
   * test or a11y label change can distinguish the two without
   * touching call sites.
   */
  readonly cascade = input<boolean>(false);

  /**
   * Emitted when the user activates a swatch (keyboard Enter / Space
   * or mouse click) or the Preferred bar. The parent tree applies
   * the highlight and closes the menu chain.
   */
  readonly apply = output<HighlightFlyoutApplyEvent>();

  /**
   * Emitted when the user presses Tab inside the flyout. The parent
   * tree closes the menu chain and restores focus to the originating
   * row. Escape is NOT routed through this output; mat-menu's panel
   * listener handles Escape natively.
   */
  readonly close = output<void>();

  // 0 = Preferred bar, 1..palette.length = swatches in DOM order.
  protected readonly activeIndex = signal<number>(0);

  // Tracks the most recent interaction mode so the visible focus
  // ring fires on programmatic focus moves after keyboard arrow
  // input, even when `:focus-visible` would not match.
  protected readonly interactionMode = signal<'keyboard' | 'mouse'>('mouse');

  protected readonly activePalette = computed<readonly PaletteSwatch[]>(() =>
    this.prefs.effectiveTheme() === 'dark' ? HIGHLIGHT_PALETTE_DARK : HIGHLIGHT_PALETTE_LIGHT,
  );

  protected readonly preferredHighlightColor = computed(
    () => this.prefs.prefs().treeHighlightColors[this.prefs.effectiveTheme()].manualHighlightColor,
  );

  protected readonly preferredHighlightTextColor = computed(() =>
    contrastText(this.preferredHighlightColor()),
  );

  protected readonly preferredHighlightAriaLabel = computed(() => {
    const hex = this.preferredHighlightColor();
    return $localize`:@@tree.highlight.swatch.preferred.aria:Apply preferred highlight color (${hex}:hex:)`;
  });

  // The grid is rendered as two rows of five. Slicing the flat
  // palette into rows up-front lets the template use a nested `@for`
  // and emit `role="row"` wrappers; that pair is what gives screen
  // readers positional ("row 1 of 2, column 3 of 5") context.
  protected readonly paletteRows = computed<readonly (readonly PaletteSwatch[])[]>(() => {
    const palette = this.activePalette();
    return [palette.slice(0, 5), palette.slice(5, 10)];
  });

  protected readonly preferredHighlightLabel = $localize`:@@tree.highlight.swatch.preferred:Preferred`;

  protected highlightSwatchLabel(swatch: PaletteSwatch): string {
    return $localize`:@@tree.highlight.swatch.aria:${swatch.name}:name: ${swatch.hex}:hex:`;
  }

  private readonly preferredBar = viewChild<ElementRef<HTMLButtonElement>>('preferredBar');
  private readonly swatchButtons = viewChildren<ElementRef<HTMLButtonElement>>('swatchButton');

  protected tabIndexFor(index: number): 0 | -1 {
    return this.activeIndex() === index ? 0 : -1;
  }

  protected isActive(index: number): boolean {
    return this.activeIndex() === index;
  }

  /**
   * Swatch DOM index (0..palette.length-1). The Preferred bar is
   * `activeIndex === 0`; swatches are `activeIndex === 1 + swatchIndex`.
   */
  protected swatchActiveIndex(rowIndex: number, colIndex: number): number {
    return 1 + rowIndex * 5 + colIndex;
  }

  /**
   * Called by the parent tree from each `<mat-menu>`'s `(menuOpened)`
   * event. Resets `activeIndex` to the Preferred bar and moves DOM
   * focus there after a microtask + change-detection pass so the
   * roving `[attr.tabindex]="0"` has actually landed in the DOM
   * before `.focus()` is called (headless Chromium silently drops
   * `.focus()` on `tabindex="-1"` elements).
   */
  focusEntry(): void {
    this.activeIndex.set(0);
    this.interactionMode.set('keyboard');
    queueMicrotask(() => {
      this.cdr.detectChanges();
      this.preferredBar()?.nativeElement.focus();
    });
  }

  @HostListener('keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    const key = event.key;
    if (
      key !== 'ArrowDown' &&
      key !== 'ArrowUp' &&
      key !== 'ArrowLeft' &&
      key !== 'ArrowRight' &&
      key !== 'Enter' &&
      key !== ' ' &&
      key !== 'Spacebar' &&
      key !== 'Tab'
    ) {
      return;
    }

    const idx = this.activeIndex();
    const isPreferred = idx === 0;
    const swatchIndex = idx - 1;
    const row = isPreferred ? -1 : Math.floor(swatchIndex / 5);
    const col = isPreferred ? -1 : swatchIndex % 5;

    switch (key) {
      case 'ArrowDown': {
        event.preventDefault();
        event.stopPropagation();
        if (isPreferred) {
          this.moveActive(1);
        } else if (row === 0) {
          this.moveActive(1 + 5 + col);
        }
        // row 1: no wrap.
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        event.stopPropagation();
        if (row === 1) {
          this.moveActive(1 + col);
        } else if (row === 0) {
          this.moveActive(0);
        }
        // preferred: no wrap.
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        event.stopPropagation();
        if (!isPreferred && col > 0) {
          this.moveActive(idx - 1);
        }
        return;
      }
      case 'ArrowRight': {
        event.preventDefault();
        event.stopPropagation();
        if (!isPreferred && col < 4) {
          this.moveActive(idx + 1);
        }
        return;
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        event.stopPropagation();
        this.interactionMode.set('keyboard');
        this.emitApply('keyboard');
        return;
      }
      case 'Tab': {
        event.preventDefault();
        event.stopPropagation();
        this.close.emit();
        return;
      }
    }
  }

  private moveActive(nextIndex: number): void {
    this.interactionMode.set('keyboard');
    if (this.activeIndex() === nextIndex) {
      // Re-focus the same cell (e.g., clamping back to Preferred from
      // ArrowUp). Ensures the visual ring stays in sync with the
      // user's last keypress.
      this.focusActive();
      return;
    }
    this.activeIndex.set(nextIndex);
    // Defer focus to the next microtask so the new `[attr.tabindex]="0"`
    // has landed in the DOM before `.focus()` is called. Chromium's
    // headless mode silently drops `.focus()` on `tabindex="-1"`
    // buttons, which is what every non-active cell carries.
    queueMicrotask(() => {
      this.cdr.detectChanges();
      this.focusActive();
    });
  }

  private focusActive(): void {
    const idx = this.activeIndex();
    if (idx === 0) {
      this.preferredBar()?.nativeElement.focus();
      return;
    }
    const swatchIdx = idx - 1;
    const buttons = this.swatchButtons();
    buttons[swatchIdx]?.nativeElement.focus();
  }

  protected onPreferredEnter(): void {
    if (this.activeIndex() !== 0) this.activeIndex.set(0);
    this.interactionMode.set('mouse');
  }

  protected onSwatchEnter(rowIndex: number, colIndex: number): void {
    const next = this.swatchActiveIndex(rowIndex, colIndex);
    if (this.activeIndex() !== next) this.activeIndex.set(next);
    this.interactionMode.set('mouse');
  }

  protected onPreferredFocus(): void {
    if (this.activeIndex() !== 0) this.activeIndex.set(0);
  }

  protected onSwatchFocus(rowIndex: number, colIndex: number): void {
    const next = this.swatchActiveIndex(rowIndex, colIndex);
    if (this.activeIndex() !== next) this.activeIndex.set(next);
  }

  protected onPreferredClick(): void {
    this.activeIndex.set(0);
    this.interactionMode.set('mouse');
    this.emitApply('mouse');
  }

  protected onSwatchClick(rowIndex: number, colIndex: number): void {
    this.activeIndex.set(this.swatchActiveIndex(rowIndex, colIndex));
    this.interactionMode.set('mouse');
    this.emitApply('mouse');
  }

  private emitApply(inputMode: 'keyboard' | 'mouse'): void {
    const idx = this.activeIndex();
    let color: string;
    if (idx === 0) {
      color = this.preferredHighlightColor();
    } else {
      const swatchIdx = idx - 1;
      const palette = this.activePalette();
      const swatch = palette[swatchIdx];
      if (!swatch) return;
      color = swatch.hex;
    }
    this.apply.emit({ color, inputMode });
  }
}
