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
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/auth/auth.service';
import { PreferencesService } from '../../../core/preferences/preferences.service';
import { IconComponent, JjIconName } from '../icon/icon.component';

export type EditorMode = 'json' | 'jsonc';

@Component({
  selector: 'jj-toolbar',
  standalone: true,
  imports: [MatButtonModule, MatTooltipModule, MatButtonToggleModule, RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss'
})
export class ToolbarComponent {
  private readonly prefs = inject(PreferencesService);
  private readonly auth = inject(AuthService);

  readonly mode = input<EditorMode>('json');
  readonly hasContent = input<boolean>(false);
  readonly title = input<string>('');
  readonly canSave = input<boolean>(false);
  readonly saveInFlight = input<boolean>(false);

  readonly pasteRequested = output<void>();
  readonly copyRequested = output<void>();
  readonly copyEscaped = output<void>();
  readonly upload = output<File>();
  readonly download = output<void>();
  readonly clear = output<void>();
  readonly format = output<void>();
  readonly minify = output<void>();
  readonly modeChange = output<EditorMode>();
  readonly toggleLayout = output<void>();
  readonly toggleTheme = output<void>();
  readonly save = output<void>();
  readonly titleChange = output<string>();

  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly layoutIcon = computed<JjIconName>(() =>
    this.prefs.prefs().layoutOrientation === 'horizontal'
      ? 'layout-vertical'
      : 'layout-horizontal'
  );

  readonly themeIcon = computed<JjIconName>(() => {
    const theme = this.prefs.prefs().theme;
    if (theme === 'light') return 'sun';
    if (theme === 'dark') return 'moon';
    return 'system';
  });

  readonly isSignedIn = this.auth.isSignedIn;
  readonly user = this.auth.user;
  readonly authConfigured = this.auth.isConfigured;

  readonly saveDisabled = computed(
    () => !this.canSave() || !this.hasContent() || this.saveInFlight()
  );

  readonly saveTooltip = computed(() => {
    if (this.saveInFlight()) return $localize`:@@toolbar.save.tooltip.saving:Saving...`;
    if (!this.authConfigured || !this.isSignedIn()) {
      return $localize`:@@toolbar.save.tooltip.signIn:Sign in to save & share`;
    }
    if (!this.hasContent()) return $localize`:@@toolbar.save.tooltip.empty:Nothing to save`;
    return $localize`:@@toolbar.save.tooltip.save:Save & share`;
  });

  onTitleInput(ev: Event): void {
    const value = (ev.target as HTMLInputElement).value;
    this.titleChange.emit(value);
  }

  onTitleKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !this.saveDisabled()) {
      ev.preventDefault();
      this.save.emit();
    }
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

  /**
   * Click handler for the Copy button. Alt-click is a power-user affordance
   * that copies the editor contents as a JSON-string-literal (see issue #38).
   */
  onCopyClick(ev: MouseEvent): void {
    if (ev.altKey) {
      this.copyEscaped.emit();
    } else {
      this.copyRequested.emit();
    }
  }

  onSignIn(): void {
    this.auth.signIn();
  }

  onSignOut(): void {
    this.auth.signOut();
  }
}

