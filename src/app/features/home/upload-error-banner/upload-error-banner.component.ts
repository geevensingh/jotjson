import {
  ChangeDetectionStrategy,
  Component,
  input,
  output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

/**
 * Banner shown above the editor when an upload (file picker or drag-drop)
 * loaded raw text whose contents are not valid JSON/JSONC. Persistent
 * (until dismissed or until content next parses cleanly) so the user can
 * tell the failure came from their upload rather than ordinary typing.
 *
 * Stateless and presentational: visibility and filename are driven by
 * signal inputs from the host component. User intent is reported via
 * the `dismiss` output. Modeled on `ExtractJsonBannerComponent` for
 * visual consistency with the M7p extract banner.
 */
@Component({
  selector: 'jj-upload-error-banner',
  standalone: true,
  imports: [MatButtonModule, MatCardModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './upload-error-banner.component.html',
  styleUrl: './upload-error-banner.component.scss'
})
export class UploadErrorBannerComponent {
  readonly visible = input.required<boolean>();
  readonly filename = input.required<string>();

  readonly dismiss = output<void>();
}
