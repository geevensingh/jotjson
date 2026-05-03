import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';

/**
 * Angular-side bridge between the static cold-boot splash in
 * `src/index.html` and the first rendered route. Renders the same
 * `.jot-splash` markup as the static splash so the global styles in
 * index.html's `<head>` apply identically and the bootstrap-to-app
 * transition is visually continuous. The label is the only thing that
 * changes when the resolver for a `/s/:slug` deep-link is in flight.
 *
 * The accessible name is the visible `<p>` text inside the
 * `role="status"` region; we deliberately do not set `aria-label`
 * because that would override the visible-text accessible name and
 * defeat the label switch. `aria-live="polite"` carries any subsequent
 * label changes to assistive tech.
 *
 * Pre-bootstrap strings ("Loading JotJSON..." / "Loading JSON...") in
 * `index.html` are an i18n exception (documented in AGENTS.md); the
 * post-bootstrap labels here go through `$localize` like the rest of
 * the app.
 */
@Component({
  selector: 'app-loading-splash',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './loading-splash.component.html',
})
export class LoadingSplashComponent {
  private readonly splash = inject(LoadingSplashService);
  protected readonly kind = this.splash.kind;
  protected readonly label = computed(() => {
    const current = this.kind();
    if (current === 'blob') {
      return $localize`:@@splash.label.blob:Loading JSON...`;
    }
    if (current === 'jotjson') {
      return $localize`:@@splash.label.jotjson:Loading JotJSON...`;
    }
    return null;
  });
}
