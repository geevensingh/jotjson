import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { RuleSetsService } from '../../../core/api/rule-sets.service';
import {
  FORMATTING_ICONS,
  FormattingIcon,
  FormattingRule,
  FormattingRuleMatchType,
  FormattingRuleSet
} from '../../../core/api/models';
import { AppHeaderComponent } from '../../../shared/components/app-header/app-header.component';
import { IconComponent } from '../../../shared/components/icon/icon.component';

type LoadState = 'loading' | 'ready' | 'not_found' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const DEFAULT_NEW_RULE_STYLE = (): FormattingRule['style'] => ({
  backgroundColor: '#ffe4b5',
  textColor: '#1f2937'
});

/**
 * M6d-1 rule editor. Loads a single rule set by route id, lets the
 * signed-in user edit its name and rules, and saves on demand via a
 * manual "Save" button. Valid-only autosave + 412 concurrency banner +
 * live preview ship in M6d-2 / M6d-3.
 */
@Component({
  selector: 'app-rule-editor',
  standalone: true,
  imports: [
    AppHeaderComponent,
    FormsModule,
    IconComponent,
    MatButtonModule,
    MatButtonToggleModule,
    MatSlideToggleModule,
    RouterLink
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-editor.component.html',
  styleUrl: './rule-editor.component.scss'
})
export class RuleEditorComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(RuleSetsService);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  readonly loadState = signal<LoadState>('loading');
  readonly saveState = signal<SaveState>('idle');
  readonly draft = signal<FormattingRuleSet | null>(null);

  readonly icons: readonly FormattingIcon[] = FORMATTING_ICONS;
  readonly targetOptions: readonly FormattingRule['target'][] = [
    'key',
    'value',
    'key_and_value'
  ];
  readonly matchTypeOptions: readonly FormattingRuleMatchType[] = [
    'exact',
    'contains',
    'starts_with',
    'ends_with'
  ];

  /** Auto-generated label per F1: e.g. `key contains "error"`. */
  ruleLabel(rule: FormattingRule): string {
    const targetLabel =
      rule.target === 'key_and_value' ? 'key+value' : rule.target;
    const verb = rule.matchType.replace(/_/g, ' ');
    const value = rule.matchValue ? `"${rule.matchValue}"` : '(empty)';
    return `${targetLabel} ${verb} ${value}`;
  }

  ngOnInit(): void {
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const id = params.get('id');
        if (!id) {
          void this.router.navigate(['/formatting-rules']);
          return;
        }
        void this.loadById(id);
      });
  }

  private async loadById(id: string): Promise<void> {
    this.loadState.set('loading');
    const cached = this.service.ruleSets()?.find((s) => s.id === id);
    if (cached) {
      this.draft.set(this.cloneSet(cached));
      this.loadState.set('ready');
      return;
    }
    try {
      const set = await firstValueFrom(this.service.get(id));
      this.draft.set(this.cloneSet(set));
      this.loadState.set('ready');
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) {
        this.loadState.set('not_found');
        this.snack.open(
          $localize`:@@ruleEditor.notFound:Rule set not found.`,
          $localize`:@@common.dismiss:Dismiss`,
          { duration: 4000 }
        );
        void this.router.navigate(['/formatting-rules']);
        return;
      }
      this.loadState.set('error');
    }
  }

  setName(value: string): void {
    const current = this.draft();
    if (!current) return;
    this.draft.set({ ...current, name: value });
  }

  addRule(): void {
    const current = this.draft();
    if (!current) return;
    const newRule: FormattingRule = {
      id: this.newRuleId(),
      target: 'value',
      matchType: 'contains',
      matchValue: '',
      caseSensitive: false,
      style: DEFAULT_NEW_RULE_STYLE()
    };
    this.draft.set({ ...current, rules: [...current.rules, newRule] });
  }

  removeRule(index: number): void {
    const current = this.draft();
    if (!current) return;
    const next = current.rules.slice();
    next.splice(index, 1);
    this.draft.set({ ...current, rules: next });
  }

  moveRule(index: number, direction: -1 | 1): void {
    const current = this.draft();
    if (!current) return;
    const target = index + direction;
    if (target < 0 || target >= current.rules.length) return;
    const next = current.rules.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    this.draft.set({ ...current, rules: next });
  }

  patchRule(index: number, patch: Partial<FormattingRule>): void {
    const current = this.draft();
    if (!current) return;
    const next = current.rules.slice();
    const merged = { ...next[index], ...patch };
    next[index] = merged;
    this.draft.set({ ...current, rules: next });
  }

  patchStyle(
    index: number,
    patch: Partial<FormattingRule['style']>
  ): void {
    const current = this.draft();
    if (!current) return;
    const next = current.rules.slice();
    const rule = next[index];
    next[index] = { ...rule, style: { ...rule.style, ...patch } };
    this.draft.set({ ...current, rules: next });
  }

  /** Set the icon dropdown; empty string clears the icon. */
  setIcon(index: number, value: string): void {
    if (value === '') {
      this.patchStyle(index, { icon: undefined });
      return;
    }
    const icon = FORMATTING_ICONS.find((i) => i === value);
    if (!icon) return;
    this.patchStyle(index, { icon });
  }

  /**
   * Manual save (M6d-1). Sends the current draft via PUT with the
   * cached version. Autosave + 412 conflict banner ship in M6d-2.
   */
  async onSave(): Promise<void> {
    const current = this.draft();
    if (!current) return;
    if (this.saveState() === 'saving') return;
    this.saveState.set('saving');
    try {
      const next = await firstValueFrom(
        this.service.update(
          current.id,
          { name: current.name, rules: current.rules },
          current.version
        )
      );
      this.draft.set(this.cloneSet(next));
      this.saveState.set('saved');
      // Auto-revert to idle after a moment so the user knows when a
      // subsequent edit lands them back in 'idle' (M6d-2 will replace
      // this with a real Editing state).
      setTimeout(() => {
        if (this.saveState() === 'saved') this.saveState.set('idle');
      }, 2000);
    } catch (err) {
      this.saveState.set('error');
      const message =
        err instanceof HttpErrorResponse && err.status === 412
          ? $localize`:@@ruleEditor.save.conflict:This rule set was changed in another tab. Reload to continue.`
          : $localize`:@@ruleEditor.save.failed:Save failed. Please try again.`;
      this.snack.open(
        message,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 5000 }
      );
    }
  }

  trackByRule(_index: number, rule: FormattingRule): string {
    return rule.id;
  }

  private cloneSet(set: FormattingRuleSet): FormattingRuleSet {
    return {
      ...set,
      rules: set.rules.map((r) => ({ ...r, style: { ...r.style } }))
    };
  }

  private newRuleId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
