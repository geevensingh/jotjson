import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';

/**
 * Angular-side bridge between the static cold-boot splash in
 * `src/index.html` and the first rendered route. Renders the same
 * `.jot-splash` markup as the static splash so the global styles in
 * index.html's `<head>` apply identically and the bootstrap-to-app
 * transition is visually continuous.
 *
 * The label cycles through three lifecycle stages driven by
 * `LoadingSplashService` - "Loading JotJSON..." (bootstrap),
 * "Downloading JSON..." (blob fetch in flight), "Rendering tree..."
 * (post-fetch CD pass mounting the tree). The progress bar is
 * intentionally hidden during the render-pending stage because there
 * is no honest progress signal to show during a synchronous CD pass,
 * and a bar pinned at 100% reads as "stuck" - the very perception
 * this stage exists to fix.
 *
 * The accessible name is the visible `<p>` text inside the
 * `role="status"` region; we deliberately do not set `aria-label`
 * because that would override the visible-text accessible name and
 * defeat the label switch. `aria-live="polite"` carries each label
 * change to assistive tech.
 *
 * Pre-bootstrap strings ("Loading JotJSON...") in `index.html` are an
 * i18n exception (documented in AGENTS.md); the post-bootstrap labels
 * here go through `$localize` like the rest of the app.
 */
@Component({
  selector: 'app-loading-splash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './loading-splash.component.html',
})
export class LoadingSplashComponent {
  private readonly splash = inject(LoadingSplashService);
  protected readonly kind = this.splash.kind;
  protected readonly renderPending = this.splash.renderPending;
  protected readonly progress = this.splash.progress;
  protected readonly determinate = computed(() => this.progress() !== null);
  protected readonly progressFraction = computed(() => this.progress() ?? 0);
  protected readonly visible = computed(() => this.kind() !== null || this.renderPending());
  protected readonly barVisible = computed(() => this.visible() && !this.renderPending());
  protected readonly label = computed(() => {
    if (this.renderPending()) {
      return $localize`:@@splash.label.render:Rendering tree...`;
    }
    const current = this.kind();
    if (current === 'blob') {
      return $localize`:@@splash.label.blob:Downloading JSON...`;
    }
    if (current === 'jotjson') {
      return $localize`:@@splash.label.jotjson:Loading JotJSON...`;
    }
    return null;
  });
}
