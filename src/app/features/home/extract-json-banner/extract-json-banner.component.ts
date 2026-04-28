import {
  ChangeDetectionStrategy,
  Component,
  input,
  output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

/**
 * Banner shown above the editor when the JSON extractor finds one or more
 * candidate JSON blocks inside otherwise-mixed text the user just pasted.
 *
 * Stateless and presentational: visibility, block count, and whether comments
 * survive extraction are all driven by signal inputs from the host component.
 * User intent is reported via the `extract` and `dismiss` outputs.
 */
@Component({
  selector: 'jotjson-extract-json-banner',
  standalone: true,
  imports: [MatButtonModule, MatCardModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './extract-json-banner.component.html',
  styleUrl: './extract-json-banner.component.scss'
})
export class ExtractJsonBannerComponent {
  readonly visible = input.required<boolean>();
  readonly blockCount = input.required<number>();
  readonly preservesComments = input.required<boolean>();

  readonly extract = output<void>();
  readonly dismiss = output<void>();
}
