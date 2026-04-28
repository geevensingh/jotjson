import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input
} from '@angular/core';

import { FormattingRuleSet } from '../../../../core/api/models';
import { JsonTreeComponent } from '../../../../shared/components/json-tree/json-tree.component';

/**
 * Static representative sample shown in the live preview. Picked to
 * exercise the common rule shapes a user is likely to write while
 * editing: matching on a key (`error`, `status`, `email`), matching
 * by value (the `"TypeError"` string, the `500` numeric status), and
 * a mix of containers, primitives, `null`, and an array so container
 * vs leaf rendering both have something to show.
 */
const SAMPLE: Readonly<Record<string, unknown>> = Object.freeze({
  status: 500,
  error: 'TypeError',
  errorType: 'error',
  message: 'Cannot read properties of undefined',
  user: {
    id: 42,
    email: 'user@example.com',
    active: true
  },
  tags: ['retry', 'critical'],
  resolvedAt: null
});

/**
 * M6d-3 live preview. Renders a built-in static sample JSON through
 * the production `JsonTreeComponent` with the in-progress draft rule
 * set forwarded via `[overrideRuleSets]`. The override is a
 * per-instance Input on the tree, so this preview never affects other
 * tree instances (e.g. the home page tree).
 */
@Component({
  selector: 'app-rule-preview',
  standalone: true,
  imports: [JsonTreeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-preview.component.html',
  styleUrl: './rule-preview.component.scss'
})
export class RulePreviewComponent {
  readonly draft = input.required<FormattingRuleSet>();

  readonly sampleJson: unknown = SAMPLE;

  /** Tree consumes a list; wrap the single draft as a one-element array. */
  readonly overrideRuleSets = computed<FormattingRuleSet[]>(() => [this.draft()]);
}
