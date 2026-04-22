import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Persistent app-level header. Renders a brand wordmark that links back to
 * the editor home, giving every route a consistent way to return to `/`.
 *
 * Kept intentionally minimal: the Home page's toolbar continues to own
 * feature controls (paste, copy, sign-in, theme, etc.). This header is
 * brand-only so it doesn't duplicate toolbar affordances on Home.
 */
@Component({
  selector: 'jj-app-header',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-header.component.html',
  styleUrl: './app-header.component.scss'
})
export class AppHeaderComponent {}
