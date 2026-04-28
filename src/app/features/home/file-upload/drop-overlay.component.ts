import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Full-viewport drag-and-drop overlay for the home page (M7b).
 *
 * Displayed while the user is dragging a file over the window. The overlay
 * is `pointer-events: none` so the underlying drop target still receives
 * the drop event; this component is purely a visual affordance plus a
 * polite live region announcement for assistive technology.
 */
@Component({
  selector: 'jotjson-drop-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'status',
    'aria-live': 'polite'
  },
  template: `
    <div
      class="drop-overlay"
      [class.drop-overlay--visible]="visible()"
    >
      <div class="drop-overlay__card">
        <span
          class="drop-overlay__message"
          i18n="@@home.upload.dropOverlay.message"
        >Drop JSON file here</span>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: contents;
    }

    .drop-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      background: rgba(0, 0, 0, 0.35);
      transition: opacity 120ms ease-out;
    }

    .drop-overlay--visible {
      opacity: 1;
      visibility: visible;
    }

    .drop-overlay__card {
      padding: 2.5rem 3.5rem;
      border: 3px dashed var(--mat-sys-primary);
      border-radius: 12px;
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface);
      text-align: center;
    }

    .drop-overlay__message {
      font-size: 1.5rem;
      font-weight: 500;
      color: var(--mat-sys-on-surface);
    }
  `]
})
export class DropOverlayComponent {
  readonly visible = input.required<boolean>();
}
