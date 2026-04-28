import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { RuleSetsService } from '../../core/api/rule-sets.service';
import type { FormattingRuleSet } from '../../core/api/models';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * M6d-1 minimal list page for the user's rule sets. Displays a card
 * per set with an "Edit" link into the M6d editor and a "+ New rule
 * set" button that creates an empty set and navigates into the
 * editor. Rename / duplicate / delete / clone-preset / ordering /
 * empty-state polish all ship in M6e.
 */
@Component({
  selector: 'app-formatting-rules',
  standalone: true,
  imports: [
    AppHeaderComponent,
    MatButtonModule,
    RouterLink
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './formatting-rules.component.html',
  styleUrl: './formatting-rules.component.scss'
})
export class FormattingRulesComponent implements OnInit {
  private readonly service = inject(RuleSetsService);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

  readonly loadState = signal<LoadState>('loading');
  readonly creating = signal(false);

  readonly ruleSets = computed<readonly FormattingRuleSet[]>(() => {
    const cache = this.service.ruleSets();
    if (!cache) return [];
    // Stable sort by createdAt asc so the list does not jump around as
    // the user adds new sets. M6e will surface alternative orderings.
    return [...cache].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  readonly isEmpty = computed(
    () => this.loadState() === 'ready' && this.ruleSets().length === 0
  );

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loadState.set('loading');
    try {
      await firstValueFrom(this.service.list());
      this.loadState.set('ready');
    } catch {
      this.loadState.set('error');
    }
  }

  async onCreate(): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    try {
      const created = await firstValueFrom(
        this.service.create({
          name: $localize`:@@formattingRules.newRuleSet.defaultName:New rule set`,
          rules: []
        })
      );
      void this.router.navigate(['/formatting-rules', created.id]);
    } catch {
      this.snack.open(
        $localize`:@@formattingRules.create.failed:Could not create rule set. Please try again.`,
        $localize`:@@common.dismiss:Dismiss`,
        { duration: 5000 }
      );
    } finally {
      this.creating.set(false);
    }
  }

  trackById(_: number, set: FormattingRuleSet): string {
    return set.id;
  }
}
