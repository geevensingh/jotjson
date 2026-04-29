import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Icon set for the JotJSON toolbar and UI chrome. Inline SVGs at a 24x24
 * viewBox with 1.75px strokes and currentColor so they inherit text color
 * and adapt to dark/light themes without additional CSS.
 */
export type JjIconName =
  | 'paste'
  | 'copy'
  | 'upload'
  | 'download'
  | 'format'
  | 'minify'
  | 'clear'
  | 'layout-horizontal'
  | 'layout-vertical'
  | 'sun'
  | 'moon'
  | 'system'
  | 'copy-path'
  | 'chevron-right'
  | 'chevron-down'
  | 'sign-in'
  | 'sign-out'
  | 'save'
  | 'more-vert'
  | 'link'
  | 'arrows-exchange'
  | 'arrows-exchange-off'
  | 'pane-both'
  | 'pane-left-only'
  | 'pane-right-only'
  | 'globe'
  | 'lock'
  | 'trash'
  | 'edit'
  | 'eye'
  | 'folder'
  | 'history'
  | 'search'
  | 'warning'
  | 'check'
  | 'star'
  | 'info'
  | 'error'
  | 'flag'
  | 'bookmark';

@Component({
  selector: 'jj-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      class="jj-icon"
    >
      @switch (name()) {
        @case ('paste') {
          <rect x="8" y="3" width="8" height="4" rx="1" />
          <path d="M16 5h2.5A1.5 1.5 0 0 1 20 6.5v13A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-13A1.5 1.5 0 0 1 5.5 5H8" />
          <path d="M8.5 12h7M8.5 15.5h7M8.5 18.5h4" />
        }
        @case ('copy') {
          <rect x="9" y="3" width="12" height="14" rx="2" />
          <path d="M15 17v2.5A1.5 1.5 0 0 1 13.5 21h-9A1.5 1.5 0 0 1 3 19.5v-12A1.5 1.5 0 0 1 4.5 6H7" />
        }
        @case ('upload') {
          <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5z" />
          <path d="M14 3v5h5" />
          <path d="M12 18v-7" />
          <path d="M9 13.5L12 10.5l3 3" />
        }
        @case ('download') {
          <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8l-5-5z" />
          <path d="M14 3v5h5" />
          <path d="M12 11v7" />
          <path d="M9 15.5L12 18.5l3-3" />
        }
        @case ('format') {
          <path d="M8 4c-2 0-2.5 1-2.5 2.5v3c0 1.3-.7 2.5-2 2.5 1.3 0 2 1.2 2 2.5v3c0 1.5.5 2.5 2.5 2.5" />
          <path d="M16 4c2 0 2.5 1 2.5 2.5v3c0 1.3.7 2.5 2 2.5-1.3 0-2 1.2-2 2.5v3c0 1.5-.5 2.5-2.5 2.5" />
          <path d="M10 9h4M10 12h6M10 15h4" />
        }
        @case ('minify') {
          <path d="M4 4l5 5" />
          <path d="M4 9h5V4" />
          <path d="M20 4l-5 5" />
          <path d="M15 4v5h5" />
          <path d="M4 20l5-5" />
          <path d="M4 15h5v5" />
          <path d="M20 20l-5-5" />
          <path d="M20 15h-5v5" />
        }
        @case ('clear') {
          <path d="M4 7h16" />
          <path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
          <path d="M6.5 7l.85 12a2 2 0 0 0 2 1.9h5.3a2 2 0 0 0 2-1.9L17.5 7" />
          <path d="M10 11v6M14 11v6" />
        }
        @case ('layout-horizontal') {
          <rect x="3.5" y="4.5" width="7.5" height="15" rx="1.25" />
          <rect x="13" y="4.5" width="7.5" height="15" rx="1.25" />
        }
        @case ('layout-vertical') {
          <rect x="4.5" y="3.5" width="15" height="7.5" rx="1.25" />
          <rect x="4.5" y="13" width="15" height="7.5" rx="1.25" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="3.75" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        }
        @case ('moon') {
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        }
        @case ('system') {
          <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
          <path d="M3 13.5h18" />
          <path d="M9 20h6" />
          <path d="M12 16.5V20" />
        }
        @case ('copy-path') {
          <path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72" />
          <path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72" />
        }
        @case ('chevron-right') {
          <path d="M9 6l6 6-6 6" />
        }
        @case ('chevron-down') {
          <path d="M6 9l6 6 6-6" />
        }
        @case ('sign-in') {
          <circle cx="16" cy="9" r="3" />
          <path d="M11 20v-1a5 5 0 0 1 10 0v1" />
          <path d="M3 13h7" />
          <path d="M7 10l3 3-3 3" />
        }
        @case ('sign-out') {
          <circle cx="8" cy="9" r="3" />
          <path d="M3 20v-1a5 5 0 0 1 10 0v1" />
          <path d="M14 13h7" />
          <path d="M18 10l3 3-3 3" />
        }
        @case ('save') {
          <path d="M5 3h11l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V4.5A1.5 1.5 0 0 1 5.5 3" />
          <path d="M8 3v5h8V3" />
          <rect x="8" y="13" width="8" height="6" rx="0.5" />
        }
        @case ('more-vert') {
          <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
        }
        @case ('link') {
          <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
          <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
        }
        @case ('arrows-exchange') {
          <path d="M5 8h14" />
          <path d="M16 5l3 3-3 3" />
          <path d="M19 16H5" />
          <path d="M8 13l-3 3 3 3" />
        }
        @case ('arrows-exchange-off') {
          <path d="M5 8h14" />
          <path d="M16 5l3 3-3 3" />
          <path d="M19 16H5" />
          <path d="M8 13l-3 3 3 3" />
          <path d="M4 4l16 16" />
        }
        @case ('pane-both') {
          <rect x="3.5" y="4.5" width="7.5" height="15" rx="1.25" fill="currentColor" fill-opacity="0.4" />
          <rect x="13" y="4.5" width="7.5" height="15" rx="1.25" fill="currentColor" fill-opacity="0.4" />
        }
        @case ('pane-left-only') {
          <rect x="3.5" y="4.5" width="7.5" height="15" rx="1.25" fill="currentColor" fill-opacity="0.4" />
          <rect x="13" y="4.5" width="7.5" height="15" rx="1.25" />
        }
        @case ('pane-right-only') {
          <rect x="3.5" y="4.5" width="7.5" height="15" rx="1.25" />
          <rect x="13" y="4.5" width="7.5" height="15" rx="1.25" fill="currentColor" fill-opacity="0.4" />
        }
        @case ('globe') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17" />
          <path d="M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5" />
          <path d="M12 3.5c-2.5 2.5-3.5 5.5-3.5 8.5s1 6 3.5 8.5" />
        }
        @case ('lock') {
          <rect x="5" y="10.5" width="14" height="9" rx="1.5" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        }
        @case ('trash') {
          <path d="M4 7h16" />
          <path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
          <path d="M6.5 7l.85 12a2 2 0 0 0 2 1.9h5.3a2 2 0 0 0 2-1.9L17.5 7" />
          <path d="M10 11v6M14 11v6" />
        }
        @case ('history') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
          <path d="M3.5 12a8.5 8.5 0 0 1 3-6.5" />
        }
        @case ('edit') {
          <path d="M4 20h4l10.5-10.5a2 2 0 0 0-2.83-2.83L5 17.17V20z" />
          <path d="M14 7l3 3" />
        }
        @case ('eye') {
          <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
          <circle cx="12" cy="12" r="3" />
        }
        @case ('folder') {
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        }
        @case ('search') {
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4 4" />
        }
        @case ('warning') {
          <path d="M12 4l9.5 16.5h-19z" />
          <path d="M12 10v5" />
          <circle cx="12" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
        }
        @case ('check') {
          <path d="M5 12.5l4 4 10-10" />
        }
        @case ('star') {
          <path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.2L12 17.6l-5.4 2.9 1-6.2L3.2 10l6.1-.9z" />
        }
        @case ('info') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5.5" />
          <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
        }
        @case ('error') {
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />
        }
        @case ('flag') {
          <path d="M5 21V4" />
          <path d="M5 4h11l-2 4 2 4H5" />
        }
        @case ('bookmark') {
          <path d="M6 4h12v17l-6-4-6 4z" />
        }
      }
    </svg>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
      }
      .jj-icon {
        display: block;
      }
    `
  ]
})
export class IconComponent {
  readonly name = input.required<JjIconName>();
  readonly size = input<number>(20);
}
