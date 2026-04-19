import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  viewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { PreferencesService } from '../../../core/preferences/preferences.service';

export type EditorMode = 'json' | 'jsonc';

@Component({
  selector: 'jj-toolbar',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, MatButtonToggleModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss'
})
export class ToolbarComponent {
  private readonly prefs = inject(PreferencesService);

  readonly mode = input<EditorMode>('json');
  readonly hasContent = input<boolean>(false);

  readonly paste = output<void>();
  readonly upload = output<File>();
  readonly download = output<void>();
  readonly clear = output<void>();
  readonly format = output<void>();
  readonly minify = output<void>();
  readonly modeChange = output<EditorMode>();
  readonly toggleLayout = output<void>();
  readonly toggleTheme = output<void>();

  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  get layoutIcon(): string {
    return this.prefs.prefs().layoutOrientation === 'horizontal'
      ? 'splitscreen_vertical'
      : 'splitscreen';
  }

  get themeIcon(): string {
    return this.prefs.effectiveTheme() === 'light' ? 'dark_mode' : 'light_mode';
  }

  triggerFilePicker(): void {
    this.fileInput().nativeElement.click();
  }

  onFileChange(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    const file = el.files?.[0];
    if (file) this.upload.emit(file);
    el.value = '';
  }

  onModeChange(next: EditorMode): void {
    this.modeChange.emit(next);
  }
}
