import { DestroyRef, Directive, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatMenuTrigger } from '@angular/material/menu';

/**
 * Augments every MatMenuTrigger with window.blur dismissal.
 *
 * Background: Angular Material's MatMenu listens for Escape, item
 * selection, and intra-window outside clicks, but not for window.blur.
 * Monaco's editor menu does, which is why the editor pane closes its
 * context menu when you alt-tab away but our MatMenus do not. This
 * directive closes the trap.
 *
 * The selector covers both attribute spellings Material accepts.
 *
 * The blur listener is registered on `menuOpened` and removed on
 * `menuClosed`/destroy so per-row kebab triggers in JsonTreeComponent
 * (which scale with visible nodes) do not leak permanent listeners.
 */
@Directive({
  selector: '[mat-menu-trigger-for], [matMenuTriggerFor]',
  standalone: true,
})
export class CloseMatMenuOnWindowBlurDirective {
  private readonly trigger = inject(MatMenuTrigger, { self: true });
  private readonly destroyRef = inject(DestroyRef);

  private blurHandler: (() => void) | null = null;

  constructor() {
    this.trigger.menuOpened.pipe(takeUntilDestroyed()).subscribe(() => this.registerBlurHandler());
    this.trigger.menuClosed.pipe(takeUntilDestroyed()).subscribe(() => this.removeBlurHandler());
    this.destroyRef.onDestroy(() => this.removeBlurHandler());
  }

  private registerBlurHandler(): void {
    if (this.blurHandler) {
      return;
    }

    this.blurHandler = () => {
      if (this.trigger.menuOpen) {
        this.trigger.closeMenu();
      }
    };
    window.addEventListener('blur', this.blurHandler);
  }

  private removeBlurHandler(): void {
    if (!this.blurHandler) {
      return;
    }

    window.removeEventListener('blur', this.blurHandler);
    this.blurHandler = null;
  }
}
