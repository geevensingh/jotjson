import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { IconComponent, JjIconName } from '../icon/icon.component';

export type EditorMode = 'json' | 'jsonc';

@Component({
  selector: 'jj-toolbar',
  standalone: true,
  imports: [MatButtonModule, MatTooltipModule, MatButtonToggleModule, IconComponent],
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

  readonly layoutIcon = computed<JjIconName>(() =>
    this.prefs.prefs().layoutOrientation === 'horizontal'
      ? 'layout-vertical'
      : 'layout-horizontal'
  );

  readonly themeIcon = computed<JjIconName>(() =>
    this.prefs.effectiveTheme() === 'light' ? 'moon' : 'sun'
  );

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
