import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LoadingSplashService } from '../../../core/loading-splash/loading-splash.service';
import { NavigationProgressService } from '../../../core/navigation/navigation-progress.service';

/**
 * Top-of-viewport indeterminate progress bar shown while any router
 * navigation is in flight (resolver, lazy chunk, redirect, etc.).
 *
 * Position and visual style match the cold-boot splash bar in
 * `src/index.html` so the handoff at first NavigationEnd is visually
 * continuous: same 8px height, same `top: 0`, same primary color, same
 * glow.
 *
 * Suppressed while `LoadingSplashService` reports a non-null kind: the
 * splash already has its own animated bar in the same position and
 * stacking the route bar on top would double-render. Once the first
 * navigation settles the splash latches to `null` and this bar takes
 * over for all subsequent in-app navigations.
 *
 * Decorative: `aria-hidden="true"`. Screen readers should announce the
 * route change after activation, not the indicator itself. The cold-boot
 * splash carries `role="status"` for the bootstrap window where there is
 * no other content to announce.
 */
@Component({
  selector: 'app-route-progress-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './route-progress-bar.component.html',
  styleUrl: './route-progress-bar.component.scss',
})
export class RouteProgressBarComponent {
  protected readonly progress = inject(NavigationProgressService);
  private readonly splash = inject(LoadingSplashService);
  protected readonly visible = computed(
    () => this.progress.pending() && this.splash.kind() === null,
  );
}
