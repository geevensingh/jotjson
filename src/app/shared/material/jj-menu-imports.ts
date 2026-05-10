import { MatMenuModule } from '@angular/material/menu';

import { CloseMatMenuOnWindowBlurDirective } from '../directives/close-mat-menu-on-window-blur.directive';

/**
 * Imports bundle for components that use Angular Material's MatMenu.
 *
 * Use `...JJ_MENU_IMPORTS` in a component's `imports: [...]` array
 * instead of `MatMenuModule` directly. Bundling
 * `CloseMatMenuOnWindowBlurDirective` alongside `MatMenuModule`
 * guarantees every `MatMenuTrigger` auto-dismisses when the browser
 * window loses focus (matching Monaco / native context-menu
 * behavior). Direct `MatMenuModule` imports silently skip the
 * dismiss-on-blur behavior.
 */
export const JJ_MENU_IMPORTS = [MatMenuModule, CloseMatMenuOnWindowBlurDirective] as const;
