import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { RuleSetsService } from '../../../core/api/rule-sets.service';
import type { FormattingRuleSet, RuleSetPreset } from '../../../core/api/models';

/**
 * Result returned via `MatDialogRef.close()` when the user successfully
 * clones a preset. Caller (toolbar) uses both: `cloned.id` to auto-activate,
 * `preset.name` for the toast copy.
 */
export interface ClonePresetDialogResult {
  preset: RuleSetPreset;
  cloned: FormattingRuleSet;
}

type DialogState = 'loading' | 'ready' | 'error' | 'cloning';

@Component({
  selector: 'jj-clone-preset-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title i18n="@@formattingRules.clone.title">Clone a built-in preset</h2>
    <mat-dialog-content>
      @switch (state()) {
        @case ('loading') {
          <p class="status" i18n="@@formattingRules.clone.loading">Loading presets...</p>
        }
        @case ('error') {
          <p class="status status--error" i18n="@@formattingRules.clone.error">
            Could not load presets. Try again later.
          </p>
        }
        @default {
          <p class="lead" i18n="@@formattingRules.clone.lead">
            A copy will be added to your account that you can edit later.
          </p>
          <ul class="preset-list">
            @for (p of presets(); track p.id) {
              <li class="preset-row">
                <button
                  type="button"
                  class="preset-button"
                  [attr.data-preset-id]="p.id"
                  [disabled]="state() === 'cloning'"
                  (click)="onPick(p)"
                >
                  <span class="preset-name">{{ p.name }}</span>
                  <span class="preset-meta">
                    <ng-container i18n="@@formattingRules.clone.ruleCount">
                      {p.rules.length, plural, =1 {1 rule} other {{{ p.rules.length }} rules}}
                    </ng-container>
                  </span>
                </button>
              </li>
            }
          </ul>
          @if (cloneError()) {
            <p
              class="status status--error"
              data-testid="clone-error"
              i18n="@@formattingRules.clone.cloneFailed"
            >
              Clone failed. Try again.
            </p>
          }
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button
        mat-button
        type="button"
        [disabled]="state() === 'cloning'"
        (click)="ref.close()"
        i18n="@@common.cancel"
      >
        Cancel
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .lead {
        margin: 0 0 12px;
        color: var(--fg-muted, rgba(127, 127, 127, 0.85));
      }
      .preset-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .preset-button {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        width: 100%;
        padding: 10px 12px;
        background: var(--surface-1, rgba(127, 127, 127, 0.08));
        border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.25));
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        font: inherit;
        color: inherit;
      }
      .preset-button:hover:not([disabled]) {
        background: var(--surface-2, rgba(127, 127, 127, 0.16));
      }
      .preset-button:focus-visible {
        outline: 2px solid var(--focus-ring, #4c9aff);
        outline-offset: 1px;
      }
      .preset-button[disabled] {
        opacity: 0.55;
        cursor: progress;
      }
      .preset-name {
        font-weight: 600;
      }
      .preset-meta {
        font-size: 12px;
        color: var(--fg-muted, rgba(127, 127, 127, 0.85));
      }
      .status {
        margin: 0;
        color: var(--fg-muted, rgba(127, 127, 127, 0.85));
      }
      .status--error {
        color: var(--error-fg, #d32f2f);
      }
    `
  ]
})
export class ClonePresetDialogComponent implements OnInit {
  readonly ref = inject<MatDialogRef<ClonePresetDialogComponent, ClonePresetDialogResult>>(
    MatDialogRef
  );
  private readonly ruleSets = inject(RuleSetsService);

  readonly presets = signal<readonly RuleSetPreset[]>([]);
  readonly state = signal<DialogState>('loading');
  readonly cloneError = signal(false);

  ngOnInit(): void {
    this.ruleSets.listPresets().subscribe({
      next: (list) => {
        this.presets.set(list);
        this.state.set('ready');
      },
      error: () => this.state.set('error')
    });
  }

  onPick(preset: RuleSetPreset): void {
    if (this.state() === 'cloning') return;
    this.cloneError.set(false);
    this.state.set('cloning');
    this.ruleSets.clonePreset(preset.id).subscribe({
      next: (cloned) => {
        this.ref.close({ preset, cloned });
      },
      error: () => {
        this.cloneError.set(true);
        this.state.set('ready');
      }
    });
  }
}
