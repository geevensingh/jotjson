import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
}
